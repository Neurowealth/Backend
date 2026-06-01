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

### Current architecture

`src/stellar/client.ts` creates a single `rpc.Server(STELLAR_RPC_URL)` singleton. There is **no built-in automatic failover**. A mainnet RPC outage halts event ingestion and agent operations.

### Failover strategy

#### Option A: Load-balanced endpoint (recommended)

Configure a single URL that routes across multiple RPC providers:

```
STELLAR_RPC_URL=https://soroban-mainnet.stellar.org
```

Replace this with a load balancer or provider that pools:
- `https://soroban-mainnet.stellar.org` (SDF)
- `https://mainnet.sorobanrpc.com` (public)
- `https://rpc.stellar.org/mainnet` (alternative)

#### Option B: Multi-provider fallback (not yet implemented)

If you need resilience without a LB, wrap `getRpcServer()` to fall back:

```typescript
const RPC_URLS = [
  'https://soroban-mainnet.stellar.org',
  'https://mainnet.sorobanrpc.com',
]
let currentIndex = 0

export function getRpcServer(): rpc.Server {
  // Returns current server; call rotateRpc() on failure
  if (!rpcServer) rpcServer = new rpc.Server(RPC_URLS[currentIndex])
  return rpcServer
}

export function rotateRpc(): void {
  currentIndex = (currentIndex + 1) % RPC_URLS.length
  rpcServer = new rpc.Server(RPC_URLS[currentIndex])
  logger.warn(`[RPC] Failed over to ${RPC_URLS[currentIndex]}`)
}
```

Wire `rotateRpc()` into error handlers in `fetchEvents` and `submitTransaction`.

### RPC outage playbook

| Symptom | Action |
|---|---|
| `fetchEvents` fails with connection error | Rotate RPC URL (manual or automated) |
| `sendTransaction` hangs or times out | Rotate RPC; retry tx via `getTransaction` |
| Persistent RPC failures | Switch to backup RPC provider entirely |
| All known RPCs down | Pause event listener; set `agentLoop` to degraded; page on-call |

### Verify RPC health

```bash
# Check latest ledger via RPC
curl -s -X POST "$STELLAR_RPC_URL" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}' | \
  jq '.result.sequence'

# Monitor via /metrics
curl -s http://localhost:3001/metrics | grep cursor_lag
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

## 6. Incident Contacts

### Escalation tiers

| Tier | Role | Responsibility | Contact |
|---|---|---|---|
| T1 | On-call engineer | Triage, restart, DLQ retry, RPC rotation | PagerDuty / Opsgenie |
| T2 | Backend lead | Code fix, data reconciliation, migration rollback | Slack @backend-lead |
| T3 | Engineering manager | Stakeholder comms, post-mortem, priority decisions | Slack @eng-mgr |
| T4 | Security officer | Key compromise, wallet recovery, audit | Slack @sec-officer |

### Communication channels

| Channel | Purpose |
|---|---|
| `#neurowealth-alerts` | Prometheus alert notifications |
| `#neurowealth-incidents` | Incident coordination thread |
| PagerDuty | T1 on-call escalation |
| Email: `ops@neurowealth.io` | Backup contact for critical outages |

### Incident severity definitions

| Severity | Definition | Response time | Escalation |
|---|---|---|---|
| **SEV1** | Event processing halted, funds at risk, data loss | < 15 min | T1 → T2 → T3 |
| **SEV2** | Lag > 100 ledgers, DLQ > 50, agent loop degraded | < 1 hour | T1 → T2 |
| **SEV3** | Lag > 50 ledgers, DLQ > 20, elevated error rate | < 8 hours | T1 |
| **SEV4** | Minor anomalies, informational alerts | Next business day | None |

### Post-incident checklist

- [ ] Root cause identified and documented
- [ ] Fix deployed (or rollback executed)
- [ ] DLQ resolved and lag cleared
- [ ] Alert thresholds adjusted if needed
- [ ] Post-mortem filed in `docs/post-mortems/`
- [ ] Runbook updated with lessons learned

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
