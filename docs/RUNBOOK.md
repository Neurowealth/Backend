# Production Runbook — Stellar Mainnet

## 1. Network & Environment Alignment

### Verify deployment target

```bash
# Current env values (must match mainnet)
echo "STELLAR_NETWORK=$STELLAR_NETWORK"
echo "STELLAR_RPC_URL=$STELLAR_RPC_URL"
echo "VAULT_CONTRACT_ID=$VAULT_CONTRACT_ID"
```

| Variable | Mainnet value |
|---|---|
| `STELLAR_NETWORK` | `mainnet` |
| `STELLAR_RPC_URL` | `https://soroban-mainnet.stellar.org` |
| Network passphrase | `Public Global Stellar Network ; September 2015` |
| `NODE_ENV` | `production` |

Contract IDs, token addresses, and the `STELLAR_AGENT_SECRET_KEY` **must** be mainnet instances. A testnet key on mainnet will sign invalid operations.

### Pre-flight alignment checks

```bash
# 1. Confirm network in env matches deployment context
grep STELLAR_NETWORK .env | grep -q mainnet || echo "WARN: not mainnet"

# 2. Verify RPC connection returns mainnet ledger
curl -s -X POST "$STELLAR_RPC_URL" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}' | \
  jq '.result.sequence'

# 3. Confirm agent key controls the vault on this network
#    (validate via a read-only contract call — getVaultInfo or similar)

# 4. Verify Prisma migration status matches schema
npx prisma migrate status
```

### Boot sequence validation

On startup, `src/config/env.ts` validates:
- `STELLAR_NETWORK` ∈ {mainnet, testnet, futurenet}
- `STELLAR_AGENT_SECRET_KEY` starts with `S`, length 56
- `WALLET_ENCRYPTION_KEY` is exactly 64 hex chars
- All required env vars are set (throws if missing)

The `GET /health/ready` endpoint reports three subsystems: `database`, `eventListener`, `agentLoop`. All must be `ready: true` before the load balancer marks the instance healthy.

---

## 2. Key Custody

### Secrets under management

| Secret | Source | Purpose | Rotation |
|---|---|---|---|
| `STELLAR_AGENT_SECRET_KEY` | env var | Signs Soroban contract calls (rebalance, update total assets) | On key compromise or quarterly |
| `WALLET_ENCRYPTION_KEY` | env var | AES-256-GCM key encrypting custodial wallet secrets in `custodial_wallets` table | Coordinated re-encryption migration |
| `JWT_SEED` | env var | Signs session JWTs | Every 90 days (invalidates all sessions) |
| `DATABASE_URL` | env var/env file | PostgreSQL connection | DB password rotation per provider policy |

### Agent key rotation

1. Generate new Stellar keypair:
   ```bash
   stellar keys generate neurowealth-agent-v2  # or via SDK
   ```
2. Fund the new public key with XLM on mainnet.
3. If the vault contract maintains an operator allowlist, update it to include the new key.
4. Set `STELLAR_AGENT_SECRET_KEY` in your secret manager to the new **secret**.
5. Redeploy all instances (rolling update).
6. Verify agent loop health: `GET /health/ready` → `agentLoop: ready`.
7. **Keep the old key funded for 30 days** in case a rollback is needed.
8. Drain and discard the old key after the rollback window.

### Wallet encryption key rotation

1. Provision `WALLET_ENCRYPTION_KEY_NEW` in the secret manager alongside the current key.
2. Run a one-off migration script that:
   - Reads every row from `custodial_wallets`
   - Decrypts `encryptedSecret` with the old key
   - Re-encrypts with the new key
   - Writes back the new `encryptedSecret`, `iv`, `authTag`
3. Swap the env var to the new key.
4. Verify a sample of users can still sign operations.
5. Remove the old key from the secret store.

### Custodial wallet recovery

Losing `WALLET_ENCRYPTION_KEY` **permanently** destroys all custodial wallet keys.
- **Backup**: Regular DB snapshots preserve encrypted key material.
- **Audit**: The `custodial_wallets` table stores (`publicKey`, `encryptedSecret`, `iv`, `authTag`) — never plaintext secrets.
- **Disaster**: If the DB is restored from a backup, the encryption key at backup time must still be available.

### Secret storage policies

- **Never** commit secrets to git. Use `.env.example` as a template.
- **Production**: AWS Secrets Manager / HashiCorp Vault with access audit logging.
- **CI/CD**: GitHub Environments secrets, injected as env vars in deploy workflows.
- **Local dev**: `.env` file (gitignored).

---

## 3. RPC Failover

### Architecture overview

`src/stellar/client.ts` implements a multi-endpoint resilient RPC client (`ResilientRpcClient`) featuring:
- Automatic ordered failover across multiple RPC endpoints
- Isolated, per-endpoint circuit breaking via `HttpClientAdapter`
- Exponential backoff with jitter on transient failures
- Full Prometheus observability for attempt rates, failover events, circuit breaker transitions, and request latencies
- Backward-compatible single-URL fallback

All transaction submissions, transaction preparations, simulations, account lookups, transaction confirmations, and fee evaluations run through `getResilientClient().execute(fn, context)`.

The legacy `getRpcServer()` function is deprecated and routes to the primary configured endpoint (`getResilientClient().getPrimaryServer()`).

### Endpoint configuration and resolution order

Endpoints are resolved at initialization in `src/stellar/client.ts` using the following priority order:

1. `STELLAR_RPC_URLS`: Comma-separated list of HTTPS endpoints (e.g., `https://soroban-mainnet.stellar.org,https://mainnet.sorobanrpc.com,https://rpc.stellar.org/mainnet`). The first endpoint acts as primary; subsequent endpoints serve as failover targets in exact listed order.
2. `STELLAR_RPC_URL`: Single legacy HTTPS endpoint. Used if `STELLAR_RPC_URLS` is not set.
3. Network default: Derived automatically from `STELLAR_NETWORK` (`testnet`, `mainnet`, or `futurenet`) via `src/config/env.ts` if neither environment variable is provided.

See [.env.example](../.env.example) for configuration examples.

#### Environment variables

| Variable | Type | Default | Description |
|---|---|---|---|
| `STELLAR_RPC_URLS` | String (comma-separated) | Unset | Ordered list of RPC endpoints for automatic failover. Takes precedence over `STELLAR_RPC_URL`. |
| `STELLAR_RPC_URL` | String (URL) | Unset | Single fallback RPC endpoint (legacy compatibility). |
| `HTTP_CLIENT_TIMEOUT_MS` | Number (ms) | `10000` | Outgoing HTTP request timeout per call. |
| `HTTP_CLIENT_MAX_RETRIES` | Number | `3` | Maximum retry attempts per endpoint before initiating failover. |
| `HTTP_CLIENT_BASE_DELAY_MS` | Number (ms) | `200` | Base delay for exponential backoff between retries. |
| `HTTP_CLIENT_MAX_DELAY_MS` | Number (ms) | `10000` | Maximum delay cap for exponential backoff. |
| `HTTP_CLIENT_CIRCUIT_BREAKER_THRESHOLD` | Number | `5` | Consecutive failures before an endpoint's circuit breaker trips to `open`. |
| `HTTP_CLIENT_CIRCUIT_BREAKER_RESET_MS` | Number (ms) | `30000` | Duration an open circuit breaker remains `open` before entering `half-open` probe state. |

### Failover execution and circuit breaker lifecycle

Each configured endpoint receives its own `EndpointSlot` containing a dedicated `rpc.Server` and `HttpClientAdapter`. Circuit breaker state is tracked independently per endpoint:

```
[Request] ──> Try Primary Endpoint (Index 0)
                   │
                   ├──> Success ──> Return Result (Reset failure counter)
                   │
                   └──> Failure (Max retries exceeded or Circuit OPEN)
                             │
                             ├──> Increment stellar_rpc_failovers_total
                             ├──> Check Circuit Breaker Threshold
                             │       └──> If consecutive failures >= threshold: Trip to OPEN
                             │
                             └──> Failover to Secondary Endpoint (Index 1..N)
                                       │
                                       ├──> Success ──> Return Result
                                       └──> All endpoints failed ──> Throw Error
```

#### Circuit breaker states

1. **Closed**: Normal operations. Requests pass through to the endpoint.
2. **Open**: Triggered after `HTTP_CLIENT_CIRCUIT_BREAKER_THRESHOLD` consecutive failed calls. Calls immediately skip this endpoint without waiting for network timeouts, increment `stellar_rpc_circuit_open_total`, and advance to the next configured endpoint.
3. **Half-Open**: After `HTTP_CLIENT_CIRCUIT_BREAKER_RESET_MS` elapsed in the `open` state, a single probe call is permitted. If successful, the circuit resets to `closed`. If the probe fails, the circuit re-opens for another reset duration.

### Operator controls and emergency recovery

The client provides operational recovery helpers in `src/stellar/client.ts`:

- `getRpcHealthSnapshot()`: Inspect current circuit breaker states (`closed`, `open`, `half-open`) and failure counts for all configured endpoints.
- `resetRpcCircuitBreakers()`: Immediately force-resets all circuit breakers back to `closed` without requiring an application restart.

### Prometheus metrics and observability

Stellar RPC metrics are registered in `src/utils/rpc-metrics.ts` and scraped via the application's `/metrics` endpoint:

| Metric | Type | Labels | Description |
|---|---|---|---|
| `stellar_rpc_attempts_total` | Counter | `endpoint`, `context`, `primary` | Total number of RPC call attempts. |
| `stellar_rpc_failovers_total` | Counter | `endpoint`, `context` | Invocations that fell back to a secondary endpoint due to primary failure or open circuit breaker. |
| `stellar_rpc_circuit_open_total` | Counter | `endpoint`, `context` | Requests blocked and skipped because an endpoint's circuit breaker was `open`. |
| `stellar_rpc_request_duration_seconds` | Histogram | `endpoint`, `context`, `success` | Call latency distribution across buckets `[0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10]`. |

#### Querying metrics

Inspect metrics directly via curl:

```bash
# View all Stellar RPC metrics
curl -s http://localhost:3000/metrics | grep stellar_rpc_

# Check failovers across contexts
curl -s http://localhost:3000/metrics | grep stellar_rpc_failovers_total

# Check tripped circuit breakers
curl -s http://localhost:3000/metrics | grep stellar_rpc_circuit_open_total
```

#### Key PromQL alerts and dashboards

```promql
# Rate of RPC failovers over 5 minutes (alert if > 0)
sum(rate(stellar_rpc_failovers_total[5m])) by (endpoint, context)

# Active circuit breaker trip rate (alert if > 0)
sum(rate(stellar_rpc_circuit_open_total[5m])) by (endpoint)

# RPC error rate per endpoint
sum(rate(stellar_rpc_request_duration_seconds_count{success="false"}[5m])) by (endpoint)
  /
sum(rate(stellar_rpc_request_duration_seconds_count[5m])) by (endpoint)

# 95th percentile RPC latency per endpoint
histogram_quantile(0.95, sum(rate(stellar_rpc_request_duration_seconds_bucket[5m])) by (le, endpoint))
```

### RPC outage playbook

| Symptom | Cause | Action |
|---|---|---|
| Spike in `stellar_rpc_failovers_total` | Primary RPC experiencing packet loss or high error rate | None required immediately; `ResilientRpcClient` auto-routes traffic to secondary endpoints. Verify secondary capacity. |
| `stellar_rpc_circuit_open_total` > 0 | Endpoint hit failure threshold and was marked unhealthy | Inspect endpoint provider status. When provider resolves, wait for auto-reset (`HTTP_CLIENT_CIRCUIT_BREAKER_RESET_MS`) or invoke `resetRpcCircuitBreakers()`. |
| RPC calls failing across all endpoints | All providers in `STELLAR_RPC_URLS` unreachable | Update `STELLAR_RPC_URLS` with healthy alternative endpoints and restart pods; alert on-call. |
| Elevated latency in `stellar_rpc_request_duration_seconds` | Provider throttling or degraded network performance | Adjust `HTTP_CLIENT_TIMEOUT_MS` if requests hit timeout, or promote a faster secondary provider to first position in `STELLAR_RPC_URLS`. |

### Verifying endpoint health

```bash
# Check ledger sequence directly against a specific RPC URL
curl -s -X POST "https://soroban-mainnet.stellar.org" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}' | \
  jq '.result.sequence'

# Check health endpoint reporting Stellar RPC status
curl -s http://localhost:3000/health | jq '.subsystems.stellarRpc'
```

---

## 4. Ledger Lag Alerts

### Metrics

| Metric | Type | Description |
|---|---|---|
| `cursor_lag_ledgers` | Gauge | `latest_ledger - last_processed_ledger` |
| `last_processed_ledger` | Gauge | Last ledger successfully processed |
| `events_processed_total` | Counter | Events processed, labelled by type and status |

Alert rules are defined in `docs/OBSERVABILITY.md` and deployed to Prometheus.

### Alert thresholds

| Severity | Lag | Action |
|---|---|---|
| Info | > 10 ledgers | Note — may be normal during low traffic |
| Warning | > 50 ledgers for 5 min | Investigate within 1 hour |
| Critical | > 100 ledgers for 2 min | Page immediately |

### Investigation steps

```bash
# 1. Check current lag
curl -s http://localhost:3001/metrics | grep cursor_lag

# 2. Check last processed ledger in DB
psql "$DATABASE_URL" -c "SELECT * FROM event_cursors WHERE \"contractId\" = '$VAULT_CONTRACT_ID';"

# 3. Check listener logs for errors
grep "Event Listener" /var/log/app/*.log | tail -50

# 4. Check RPC connectivity
curl -s -X POST "$STELLAR_RPC_URL" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}' | \
  jq '.result.sequence'

# 5. Check for backpressure (DLQ growth)
curl -s http://localhost:3001/metrics | grep dlq_size

# 6. Check database connection pool
psql "$DATABASE_URL" -c "SELECT count(*) FROM pg_stat_activity WHERE state = 'active';"
```

### Common causes & remediation

| Cause | Signal | Fix |
|---|---|---|
| RPC outage | `fetchEvents` errors in logs | Rotate RPC endpoint (see §3) |
| DB slow / locked | High `db_operation_duration_seconds` | Check locks, pool size, index usage |
| Schema validation failures | DLQ growth, `event_validation` errors | Inspect DLQ, fix event format or validator |
| Listener crashed | `cursor_lag` rising, `agent_loop_status == 0` | Container restart, check OOM killer |
| Network partition | RPC timeouts | Check DNS, firewall, egress rules |

### Recover from lag

```bash
# If lag < 1000 ledgers — automatic backfill runs on restart
# If lag > 1000 ledgers — manual backfill recommended via admin endpoint

# Manual backfill (from a specific ledger)
# Restart the service; backfill runs automatically up to latest
# If auto-backfill is too slow, consider:
#   1. Stop the listener
#   2. Update event_cursors to an earlier ledger
#   3. Restart the listener to trigger backfill
psql "$DATABASE_URL" -c "UPDATE event_cursors SET \"lastProcessedLedger\" = $EARLIER_LEDGER WHERE \"contractId\" = '$VAULT_CONTRACT_ID';"
```

---

## 5. DLQ Replay Procedure

### Overview

Events that fail processing (validation error, DB error, missing user) are stored in the `dead_letter_events` table with status `PENDING`. The DLQ module (`src/stellar/dlq.ts`) manages retries through three admin API endpoints.

### Inspect DLQ

```bash
# Via admin API (requires ADMIN_API_TOKEN)
curl -s -H "Authorization: Bearer $ADMIN_API_TOKEN" \
  http://localhost:3001/api/admin/dlq/inspect | jq

# Filter by status
curl -s -H "Authorization: Bearer $ADMIN_API_TOKEN" \
  "http://localhost:3001/api/admin/dlq/inspect?status=PENDING" | jq

# Via direct DB query
psql "$DATABASE_URL" -c "
  SELECT id, \"eventType\", \"txHash\", ledger, status, \"retryCount\", error, \"createdAt\"
  FROM dead_letter_events
  ORDER BY \"createdAt\" DESC
  LIMIT 50;
"
```

### Dry-run retry

```bash
curl -s -X POST -H "Authorization: Bearer $ADMIN_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"dryRun": true}' \
  http://localhost:3001/api/admin/dlq/retry | jq
```

Dry run simulates the retry loop without persisting status changes.

### Full retry

```bash
curl -s -X POST -H "Authorization: Bearer $ADMIN_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}' \
  http://localhost:3001/api/admin/dlq/retry | jq
```

Returns:
```json
{
  "resolved": 5,
  "failed": 2,
  "totalRemaining": 2
}
```

### Resolve a specific event

If an event cannot be processed (e.g. user deleted), manually resolve it:

```bash
curl -s -X POST -H "Authorization: Bearer $ADMIN_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"id": "uuid-of-event"}' \
  http://localhost:3001/api/admin/dlq/resolve | jq
```

### Automatic retry behavior

- `retryAll()` processes all `PENDING` and `RETRIED` events sequentially.
- Success → status set to `RESOLVED`, count +1.
- Failure → status set to `RETRIED`, count +1, logged.
- There is **no automatic scheduled retry**. All retries are manual via the admin API.
- When DLQ size reaches 50, a critical log line is emitted and the Prometheus `dlq_size` gauge crosses the critical threshold.

### DLQ replay decision matrix

| Event type | Common failure | Retry likely? | Notes |
|---|---|---|---|
| `deposit` | User not found | No until user exists | Resolve after user registers |
| `deposit` | Schema validation | Depends | Fix validator or event source |
| `withdraw` | Position not found | No | May indicate data integrity issue |
| `rebalance` | DB constraint | Yes | Transient — retry typically succeeds |
| Any | RPC/DB timeout | Yes | Transient — retry typically succeeds |

---

## 6. Database Migration Rollback

Prisma migrations are forward-only — there is no built-in `down`. Every migration
in `prisma/migrations/<name>/` therefore ships a hand-written `rollback.sql`
alongside its `migration.sql`. CI enforces this via
`scripts/check-migration-rollback.sh`.

### When to roll back

Roll back when a freshly deployed migration is itself the problem (broken schema,
failed constraint, performance regression). If the application code is the
problem, prefer redeploying the previous app version over a schema rollback.

> **WARNING:** Rollbacks can be destructive — `DROP TABLE`/`DROP COLUMN` discard
> data. Confirm a recent backup/snapshot exists before proceeding. Some rollbacks
> are flagged partially irreversible inside their `rollback.sql` (e.g.
> `20260617000000_fix_agent_log_attribution` cannot restore `NOT NULL` if
> system-generated rows with a null `userId` exist).

### Procedure

```bash
# 1. Take / confirm a database snapshot first.

# 2. Identify the migration to reverse (most recent applied is the usual target)
npx prisma migrate status

# 3. Run the rollback for that migration (applies rollback.sql, then marks it
#    rolled back in _prisma_migrations and runs a health check).
DATABASE_URL=$DATABASE_URL bash scripts/rollback-migration.sh <migration-name>

#    Optionally verify the live app afterwards:
HEALTHCHECK_URL=http://localhost:3001/health/ready \
  DATABASE_URL=$DATABASE_URL bash scripts/rollback-migration.sh <migration-name>

# 4. Re-deploy the previous application version if the schema change was paired
#    with code changes.
```

After a successful rollback the migration is marked `rolled_back_at` in Prisma's
history, so a later `prisma migrate deploy` (with a fixed migration) re-applies it.

### Authoring rollbacks for new migrations

Every new migration PR must add a `rollback.sql` that reverses its `migration.sql`:
drop what it created, recreate what it dropped, and document any irreversible
steps as comments. The `Migration rollback check` workflow blocks merge otherwise.

## 7. Incident Contacts

Alert-by-alert steps, ack timers, and the postmortem workflow are in [INCIDENT_RESPONSE.md](./INCIDENT_RESPONSE.md). This section is the contact list those steps use.

### Escalation tiers

| Tier | Role | Responsibility | Contact |
|---|---|---|---|
| T1 | On-call engineer | Ack, triage, restart, DLQ retry, RPC rotation, sponsor top-up | PagerDuty (`PAGERDUTY_ROUTING_KEY`) |
| T2 | Backend lead | Code fix, data reconciliation, migration rollback | Slack `@backend-lead`. Page if they have not answered inside the severity window |
| T3 | Engineering manager | Stakeholder updates, priority, SEV1 postmortem acceptance | Slack `@eng-mgr` |
| T4 | Security officer | Key compromise, wallet recovery, audit | Slack `@sec-officer`. Page immediately for SEV1 security incidents, do not wait for T2 |

### Communication channels

| Channel | Purpose |
|---|---|
| `#neurowealth-alerts` | Prometheus alert notifications |
| `#neurowealth-incidents` | Incident coordination thread. The acknowledging engineer is the lead until they hand off in the thread |
| PagerDuty | T1 page, then T2 at 15 min (SEV1) or 1 hour (SEV2) if still unacked or unmitigated |
| Email: `ops@neurowealth.io` | Backup when PagerDuty or Slack is unreachable |

### Incident severity definitions

| Severity | Definition | Response time | Escalation |
|---|---|---|---|
| **SEV1** | Event processing halted, global agent breaker open, funds at risk, data loss, sponsor XLM exhausted while deposits fail | < 15 min | T1 → T2 at 15 min → T3 at 30 min. T4 immediately for key compromise |
| **SEV2** | Lag > 100 ledgers, DLQ > 50, agent loop degraded, readiness failing | < 1 hour | T1 → T2 if not mitigated in 1 hour |
| **SEV3** | Lag > 50 ledgers, DLQ > 20, elevated latency | < 8 hours | T1 |
| **SEV4** | Minor anomalies, informational alerts | Next business day | None |

### After the incident

SEV1 and SEV2 are not closed until the postmortem in [INCIDENT_RESPONSE.md](./INCIDENT_RESPONSE.md) is merged. That workflow covers the timeline, the root cause, and the action items. Update this runbook in the same follow-up when a step here was wrong or missing.

---

## Quick Reference Commands

```bash
# Health
curl http://localhost:3001/health/live
curl http://localhost:3001/health/ready
curl http://localhost:3001/health

# Metrics
curl http://localhost:3001/metrics | grep -E "(cursor_lag|dlq_size|events_processed|agent_loop)"

# DLQ inspect
curl -s -H "Authorization: Bearer $ADMIN_API_TOKEN" \
  http://localhost:3001/api/admin/dlq/inspect | jq '. | length'

# DLQ retry (dry run)
curl -s -X POST -H "Authorization: Bearer $ADMIN_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"dryRun": true}' \
  http://localhost:3001/api/admin/dlq/retry

# DLQ retry (live)
curl -s -X POST -H "Authorization: Bearer $ADMIN_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}' \
  http://localhost:3001/api/admin/dlq/retry

# DB — cursor status
psql "$DATABASE_URL" -c "SELECT * FROM event_cursors;"

# DB — DLQ count by status
psql "$DATABASE_URL" -c "
  SELECT status, count(*) FROM dead_letter_events GROUP BY status;
"

# DB — recent processed events
psql "$DATABASE_URL" -c "
  SELECT \"eventType\", ledger, \"txHash\", \"createdAt\"
  FROM processed_events
  ORDER BY ledger DESC LIMIT 10;
"
```

## 8. Sponsor Account Top-Up

Sponsored reserves move the XLM cost from user to sponsor accounts (`STELLAR_SPONSOR_KEYS`). Monitor `GET /api/v1/admin/reserves` (admin-scoped, audit-logged) for `outstandingXlm` and `perSponsor[].availableXlm`. Alert `SponsorLowXlm` fires when any sponsor `< 10 XLM` for 5m.

**Top-up:**
```bash
# Check
curl -H "Authorization: Bearer $ADMIN_API_TOKEN" http://localhost:3001/api/v1/admin/reserves | jq

# Fund sponsor from treasury/ops hot wallet via Stellar Laboratory or
stellar account fund --destination <sponsorPublicKey> --amount 100 --network public

# Verify
curl -s http://localhost:3001/metrics | grep sponsor_available_xlm
psql "$DATABASE_URL" -c "SELECT \"sponsorAccount\", count(*), sum(\"xlmReserved\") FROM reserve_sponsorships WHERE status='ACTIVE' GROUP BY \"sponsorAccount\";"
```

No auto top-up — operational runbook only. Reconciliation job (`reserveReconciliation` hourly) flags drift where on-chain sponsor ≠ ledger.

## 9. Agent Circuit Breaker (#345)

The agent circuit breaker halts agent-initiated rebalancing when the market,
a protocol, or a user's account shows risk. It never touches withdrawals.
Scopes: `GLOBAL` (halt everything), `PROTOCOL` (halt a target protocol +
batches leaving it), `USER` (halt that user's batches). Breakers are
`CLOSED → OPEN → HALF_OPEN → CLOSED`; an `OPEN` breaker auto-probes after its
cooldown and needs `BREAKER_DEPEG_SUSTAINED_CHECKS` clean evaluations before
recovering to `HALF_OPEN`, then one clean probe to close.

### Rules

| Rule | Env | Default | Trips when |
|---|---|---|---|
| abnormal_loss | `BREAKER_LOSS_PCT`, `BREAKER_LOSS_WINDOW_HOURS` | 5% / 24h | mark-to-market drawdown over the window exceeds the pct |
| depeg | `BREAKER_DEPEG_ENABLED` (=`false`) | off | reported stablecoin price deviates > `BREAKER_DEPEG_BPS` (150) from $1 |
| oscillation | `BREAKER_MAX_FLIPS`, `BREAKER_FLIP_WINDOW_HOURS` | 3 / 24h | same batch rebalances ≥ N times in the window |
| stale_data | `BREAKER_STALE_MINUTES`, `BREAKER_STALE_CONSECUTIVE_FAILURES` | 120m / 3 | APY table older than limit, never scanned, or ≥ N consecutive failures |

`BREAKER_COOLDOWN_MS` (1h) is the base cooldown; a repeated HALF_OPEN trip
doubles it up to `BREAKER_MAX_COOLDOWN_MS` (24h).

### Known limitation — de-peg price feed

The de-peg rule is a pure consumer of a stablecoin spot price. As of this
change no live price feed exists in this codebase: the fee oracle
(`src/stellar/feeOracle.ts`) publishes only fees, and `src/stellar/routing.ts`
is a stub. `getStablecoinPrice()` (`src/agent/breakerService.ts`) is the single
integration point and currently returns `null` (fails safe — the rule never
trips); the rule is disabled by default. Wire the oracle there, keep the pure
rule unchanged, flip `BREAKER_DEPEG_ENABLED=true`, and re-run the de-peg unit
tests.

### Inspector

```bash
# All breakers with current state
curl -H "Authorization: Bearer $ADMIN_API_TOKEN" http://localhost:3001/api/v1/admin/agent/breakers | jq

# Agent status (incl. cached global breaker summary)
curl -H "X-Internal-Token: $INTERNAL_SERVICE_TOKEN" http://localhost:3001/api/v1/agent/status | jq
```

### Manual trip

`POST /api/v1/admin/agent/breakers` — body `{"scope":"PROTOCOL","scopeKey":"blend","reason":"..."}`.
`GLOBAL` needs no `scopeKey`; `USER`/`PROTOCOL` require it. `reason` is always
required. Written to the admin audit log (`TRIP_AGENT_BREAKER`).

```bash
curl -X POST http://localhost:3001/api/v1/admin/agent/breakers \
  -H "Authorization: Bearer $ADMIN_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"scope":"PROTOCOL","scopeKey":"blend","reason":"incident-4821 protocol outage"}'
```

A manual trip can only be cleared manually (`rule=manual` breakers never
auto-reset). Manual resets are audit-logged too:

```bash
curl -X POST http://localhost:3001/api/v1/admin/agent/breakers/<id>/reset \
  -H "Authorization: Bearer $ADMIN_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"reason":"incident-4821 resolved, APY table verified fresh"}'
```

A breaker skips its tick when evaluation itself fails: the agent alerts
(critical, `agent-breaker:eval-failed`) and halts **all** rebalancing for that
tick rather than trading blind.

### Response

1. **Global halt**: investigate the trip rule (`agent_breaker_trips_total{scope="GLOBAL"}`), check the `[Breaker]` logs for the `lastEvaluation` detail, fix root cause, then either wait for auto-recovery or reset manually.
2. **Protocol halt**: verify the protocol's APY/status independently before resetting; `compareProtocols` already refuses it as a target while OPEN.
3. **User halt**: confirm with the user before resetting.
4. **Evaluation-failed halt**: the breaker could not decide — check DB connectivity and the logged error before the next tick.

### Verify

```bash
curl -s http://localhost:3001/metrics | grep -E "agent_breaker_(state|trips_total)"
psql "$DATABASE_URL" -c "SELECT scope, \"scopeKey\", state, \"trippedRule\" FROM agent_circuit_breakers ORDER BY \"updatedAt\" DESC;"
```
