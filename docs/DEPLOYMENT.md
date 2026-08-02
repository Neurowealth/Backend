# NeuroWealth Backend Deployment Guide

Complete guide for deploying the NeuroWealth backend across all environments.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Local Development (Docker Compose)](#local-development-docker-compose)
- [Staging (Docker)](#staging-docker)
- [Production (Kubernetes)](#production-kubernetes)
- [Environment Variables Reference](#environment-variables-reference)
- [Health Probes](#health-probes)
- [Secrets Management](#secrets-management)
- [Database Migrations](#database-migrations)
- [Rollback Procedure](#rollback-procedure)
- [Monitoring and Observability](#monitoring-and-observability)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| Node.js 20 | Matches `Dockerfile` and CI |
| Docker | For local development and container builds |
| Kubernetes 1.25+ | For production (EKS, GKE, AKS) |
| PostgreSQL 14+ | Managed database (RDS, Cloud SQL) |
| Container registry | For pushing Docker images |
| Stellar Soroban RPC | `STELLAR_RPC_URL` or comma-separated `STELLAR_RPC_URLS` for failover |
| TLS certificate | cert-manager, cloud LB, or manual `Secret` for ingress |
| Secrets store | External Secrets Operator, Sealed Secrets, or `kubectl create secret` |

---

## Local Development (Docker Compose)

### Quick Start

```bash
# Clone the repository
git clone https://github.com/Neurowealth/Backend.git
cd Backend

# Copy environment variables
cp .env.example .env

# Start PostgreSQL with Docker Compose
docker-compose up -d

# Install dependencies
npm install

# Generate Prisma client
npx prisma generate

# Apply database migrations
npx prisma migrate deploy

# Start development server
npm run dev
```

### Docker Compose Services

The `docker-compose.yml` runs:
- **PostgreSQL** on port 5432
- **Application** on port 3001 (optional)

### Verifying Local Setup

```bash
# Check health endpoint
curl http://localhost:3001/health/live

# Check readiness (requires database connection)
curl http://localhost:3001/health/ready
```

---

## Staging (Docker)

### Build Docker Image

```bash
# Build the image
docker build -t neurowealth-backend:staging .

# Tag for your registry
docker tag neurowealth-backend:staging <registry>/neurowealth-backend:staging

# Push to registry
docker push <registry>/neurowealth-backend:staging
```

### Deploy with Docker

```bash
# Run the container
docker run -d \
  --name neurowealth-backend-staging \
  -p 3001:3001 \
  --env-file /path/to/staging.env \
  <registry>/neurowealth-backend:staging
```

### Staging Environment Variables

```bash
NODE_ENV=staging
STELLAR_NETWORK=testnet
STELLAR_RPC_URL=https://soroban-testnet.stellar.org
CORS_ORIGINS=https://staging.neurowealth.io
LOG_LEVEL=debug
```

---

## Production (Kubernetes)

### Manifest Layout

All manifests live under `deploy/k8s/`:

| File | Purpose |
|------|---------|
| `namespace.yaml` | `neurowealth` namespace |
| `configmap.yaml` | Non-secret environment (CORS, rate limits, RPC URLs, contract IDs) |
| `secret.yaml.example` | **Template only** — copy values into a real Secret |
| `serviceaccount.yaml` | Pod service account |
| `deployment.yaml` | App Deployment with initContainer migration + probes |
| `service.yaml` | ClusterIP on port 3001 |
| `ingress.yaml` | TLS termination (adjust host / ingress class) |
| `migration-job.yaml` | Standalone pre-deploy migration Job |
| `hpa.yaml` | HPA pinned to 1 replica (see scaling constraints) |

### Environment Matrix

| Setting | Staging | Production |
|---------|---------|------------|
| `NODE_ENV` | `staging` | `production` |
| `STELLAR_NETWORK` | `testnet` | `mainnet` |
| `STELLAR_RPC_URL` | Testnet Soroban RPC | Mainnet Soroban RPC |
| `CORS_ORIGINS` | Staging frontend URL | Production frontend URL |
| `LOG_LEVEL` | `debug` | `info` |
| `replicas` | `1` | `1` (until worker split) |
| Secrets | Staging Secret / external store | Production Secret / external store |

### Build and Push Image

```bash
docker build -t <registry>/neurowealth-backend:<version> .
docker push <registry>/neurowealth-backend:<version>
```

Update the `image:` field in `deployment.yaml` and `migration-job.yaml` to your registry tag.

### Migration Strategy

The default `Dockerfile` CMD runs `prisma migrate deploy && node dist/index.js`. In Kubernetes, the Deployment **overrides** the command to `node dist/index.js` only. Migrations run in the **initContainer** (or standalone Job) so a failed migration blocks the rollout instead of leaving a half-started pod serving traffic.

### Rollout Procedure

#### 1. Migrate

**Option A — initContainer (default in `deployment.yaml`):** migrations run automatically before each pod starts.

**Option B — standalone Job (recommended for large migrations):**

```bash
# Update image tag in migration-job.yaml, then:
kubectl apply -f deploy/k8s/migration-job.yaml
kubectl wait --for=condition=complete job/neurowealth-migrate -n neurowealth --timeout=300s
```

#### 2. Deploy

```bash
kubectl apply -f deploy/k8s/namespace.yaml
kubectl apply -f deploy/k8s/serviceaccount.yaml
kubectl apply -f deploy/k8s/configmap.yaml
# secrets already created above
kubectl apply -f deploy/k8s/deployment.yaml
kubectl apply -f deploy/k8s/service.yaml
kubectl apply -f deploy/k8s/ingress.yaml
```

#### 3. Verify Readiness

```bash
kubectl rollout status deployment/neurowealth-backend -n neurowealth

# Port-forward for local check:
kubectl port-forward svc/neurowealth-backend 3001:3001 -n neurowealth

curl -s http://localhost:3001/health/live
curl -s http://localhost:3001/health/ready
```

Readiness returns **200** only when database, event listener, and agent loop are all healthy. During rollout or shutdown it returns **503**.

#### 4. Smoke Test

```bash
curl -s -o /dev/null -w "%{http_code}" https://api.neurowealth.io/health
```

### Scaling Guidance

#### Current Constraint: Single Active Consumer

The monolith starts three subsystems in every pod (`src/index.ts`):
1. HTTP API
2. **Stellar event listener** — polls Soroban RPC every 5 s, persists cursor to `event_cursors`
3. **Agent cron loop** — hourly rebalance, snapshots, daily protocol scan

There is **no leader election**. Running multiple replicas will:
- Duplicate event processing (mitigated by `processed_events` idempotency, but wastes RPC quota and risks race conditions)
- Run duplicate cron jobs (rebalance checks, snapshots)

**Recommendation:** keep `replicas: 1` until the architecture is split.

#### Future Scaling Path

1. Add feature flags: `ENABLE_EVENT_LISTENER`, `ENABLE_AGENT_LOOP`
2. Split deployments:
   - `neurowealth-api` — stateless HTTP, `replicas: N`, HPA enabled
   - `neurowealth-worker` — listener + agent, `replicas: 1`
3. Optional: K8s Lease or Postgres advisory lock for worker leader election before scaling workers beyond 1

#### HPA

`deploy/k8s/hpa.yaml` is pinned to `minReplicas: 1` / `maxReplicas: 1`. Re-enable scaling only after the worker/API split.

---

## Environment Variables Reference

Copy `.env.example` as a checklist. Set every value via your secrets manager — never commit production secrets.

### Required (app will not start without these)

| Variable | Notes |
|----------|-------|
| `NODE_ENV` | Must be `production` |
| `PORT` | Default `3001` |
| `DATABASE_URL` | PostgreSQL connection string |
| `STELLAR_NETWORK` | `mainnet`, `testnet`, or `futurenet` |
| `STELLAR_RPC_URL` | Soroban RPC endpoint for the chosen network |
| `STELLAR_AGENT_SECRET_KEY` | 56-char Stellar secret (`S…`) |
| `VAULT_CONTRACT_ID` | Deployed vault contract ID |
| `USDC_TOKEN_ADDRESS` | USDC token contract on Stellar |
| `ANTHROPIC_API_KEY` | Claude API key for the agent |
| `JWT_SEED` | 64-hex secret for signing sessions — rotate every 90 days |
| `WALLET_ENCRYPTION_KEY` | 64-hex (32 bytes) — `openssl rand -hex 32` |
| `TWILIO_AUTH_TOKEN` | Required for WhatsApp webhook signature validation |

### Required in Production Only

| Variable | Notes |
|----------|-------|
| `ADMIN_API_TOKEN` | Strong token (≥ 8 chars) for `/api/admin/*` — inject via secrets manager |
| `CORS_ORIGINS` or `ALLOWED_ORIGINS` | Comma-separated frontend origins (e.g. `https://app.example.com`) — **do not use `*`** |

### Recommended

| Variable | Default | Notes |
|----------|---------|-------|
| `LOG_LEVEL` | `info` | Winston log level in production |
| `RATE_LIMIT_*` / `AUTH_RATE_LIMIT_*` | see `.env.example` | Tune per environment |
| `INTERNAL_SERVICE_TOKEN` | — | Service-to-service bypass for rate limits |
| `TRUSTED_IPS` | — | Comma-separated IPs that skip rate limits (probes, internal scrapers) |
| `DLQ_ALERT_THRESHOLD` | `50` | Alert when dead-letter queue exceeds this count |

### Reverse Proxy

Express `trust proxy` is set to `1` in `src/index.ts` so `req.ip` reflects the client behind a single load balancer. If you run behind CDN + LB (two hops), adjust that setting before deploy.

Full list and defaults: `.env.example`.

---

## Health Probes

| Probe | Path | Success | Failure | Use |
|-------|------|---------|---------|-----|
| **Liveness** | `GET /health/live` | `200` | n/a | Process is running; restart if unreachable |
| **Readiness** | `GET /health/ready` | `200` when DB, event listener, and agent loop are ready | `503` during startup or shutdown | Route traffic only to healthy instances |

Additional endpoints:
- `GET /health` — basic JSON status (also available via `healthRouter`)
- `GET /metrics` — Prometheus scrape target

### Kubernetes Example

```yaml
livenessProbe:
  httpGet:
    path: /health/live
    port: 3001
  initialDelaySeconds: 10
  periodSeconds: 15
  timeoutSeconds: 5

readinessProbe:
  httpGet:
    path: /health/ready
    port: 3001
  initialDelaySeconds: 15
  periodSeconds: 10
  timeoutSeconds: 5
  failureThreshold: 3
```

### AWS ALB Example

- **Health check path:** `/health/ready`
- **Matcher:** `200`
- **Interval:** 30 s
- **Unhealthy threshold:** 3

During graceful shutdown (`SIGTERM`/`SIGINT`), readiness returns `503` with `status: shutting_down` so load balancers stop sending new requests before the process exits.

---

## Secrets Management

### Required Production Secrets

| Secret | Rotation | Notes |
|--------|----------|-------|
| `JWT_SEED` | Every 90 days | Invalidates active sessions; schedule maintenance window |
| `WALLET_ENCRYPTION_KEY` | Coordinated migration | Re-encrypt `custodial_wallets` rows before swapping the key; loss of key = unrecoverable wallets |
| `STELLAR_AGENT_SECRET_KEY` | Rare | Fund a new agent key and update contract permissions before swap |
| `ADMIN_API_TOKEN` | On compromise | Rotate immediately; update secrets store and redeploy |
| `TWILIO_AUTH_TOKEN` | On compromise | Update Twilio console and redeploy |
| `DATABASE_URL` | Per provider policy | Use least-privilege DB user; enable SSL |

### Secret Managers (Recommended)

| Provider | Best for | Notes |
|----------|----------|-------|
| **AWS Secrets Manager** | AWS-hosted production | Automatic rotation hooks; inject via ECS task secrets or Lambda env |
| **HashiCorp Vault** | Multi-cloud / on-prem | Dynamic secrets, audit trail; use AppRole or K8s auth |
| **GitHub Actions secrets** | CI/CD and staging | Store `DATABASE_URL`, `JWT_SEED`, etc. per environment; never log values |

### Creating Kubernetes Secrets

```bash
kubectl create namespace neurowealth

kubectl create secret generic neurowealth-secrets \
  --namespace=neurowealth \
  --from-literal=DATABASE_URL='postgresql://...' \
  --from-literal=JWT_SEED='...' \
  --from-literal=WALLET_ENCRYPTION_KEY='...' \
  --from-literal=STELLAR_AGENT_SECRET_KEY='...' \
  --from-literal=ANTHROPIC_API_KEY='...' \
  --from-literal=ADMIN_API_TOKEN='...' \
  --from-literal=TWILIO_AUTH_TOKEN='...'
```

Required keys match `src/config/env.ts` startup validation. Optional keys: `TWILIO_ACCOUNT_SID`, `INTERNAL_SERVICE_TOKEN`, `SLACK_WEBHOOK_URL`, `PAGERDUTY_ROUTING_KEY`.

### Secrets Best Practices

**Do:**
- Inject secrets at runtime from a secrets manager
- Use separate credentials per environment (staging vs production)
- Take a DB snapshot before running `prisma migrate deploy`

**Do not:**
- Commit `.env` files or bake secrets into Docker image layers
- Log secret values (Winston redacts in production but avoid passing secrets in error messages)

---

## Database Migrations

### Pre-Deployment Checklist

- [ ] Review pending Prisma migrations (`npx prisma migrate status`)
- [ ] Confirm migration SQL is non-destructive or has a documented data backfill
- [ ] Take a database backup/snapshot (provider console or `pg_dump`)
- [ ] Schedule during low traffic; notify on-call
- [ ] Staging deploy passed CI (`migration-smoke` job green)

### Applying Migrations

**Option A — Docker Container (single-instance):**

```bash
docker run -d \
  --name neurowealth-migrate \
  --env-file /path/to/production.env \
  <registry>/neurowealth-backend:<version> \
  npx prisma migrate deploy
```

**Option B — Kubernetes initContainer (recommended):**

```yaml
initContainers:
  - name: migrate
    image: <registry>/neurowealth-backend:<version>
    command: ["npx", "prisma", "migrate", "deploy"]
    envFrom:
      - secretRef:
          name: neurowealth-backend-secrets
```

**Option C — Standalone Job (large migrations):**

```bash
kubectl apply -f deploy/k8s/migration-job.yaml
kubectl wait --for=condition=complete job/neurowealth-migrate -n neurowealth --timeout=300s
```

**Option D — Safe script with smoke test:**

```bash
DATABASE_URL=postgresql://... bash scripts/apply-migration.sh
```

### Verifying Migration

```bash
# Check migration status
npx prisma migrate status

# Verify database tables
psql $DATABASE_URL -c "\dt event_cursors"
psql $DATABASE_URL -c "\dt processed_events"
```

---

## Rollback Procedure

### Application Rollback

```bash
# Roll back to previous ReplicaSet
kubectl rollout undo deployment/neurowealth-backend -n neurowealth

# Or pin a known-good image:
kubectl set image deployment/neurowealth-backend \
  api=<registry>/neurowealth-backend:<previous-version> \
  -n neurowealth

kubectl rollout status deployment/neurowealth-backend -n neurowealth
```

### Database Rollback

Prisma migrations are forward-only. If a migration introduced a breaking schema change, restore from a database backup or deploy a hotfix migration — do not rely on `migrate reset` in production.

#### When to Rollback

| Situation | Action |
|-----------|--------|
| Migration applied, app bug only | Roll back **application** image to previous tag; DB unchanged |
| Bad migration, no data loss yet | Restore DB from pre-deploy snapshot; redeploy previous app + migration set |
| Bad migration with partial writes | Restore snapshot; replay DLQ after fix; document manual reconciliation |

#### Rollback Steps

1. Stop traffic to new instances (drain load balancer).
2. Restore database from the pre-deploy backup/snapshot.
3. Deploy the **previous** application image (matching the restored schema).
4. Run `npm run smoke` against the restored DB.
5. Re-enable traffic; post-mortem and fix-forward migration in a new release.

---

## Monitoring and Observability

### Metrics

- **Metrics:** `GET /metrics` on port 3001 (Prometheus)
- **Request tracing:** clients may send `X-Request-ID` or `X-Correlation-ID`; the server echoes `X-Request-ID` on every response and includes `correlationId` in structured logs
- **DLQ:** monitor `dead_letter_events` count and `event_cursors.lastProcessedLedger` lag — see `docs/OBSERVABILITY.md` and `docs/RUNBOOK.md`

### Monitoring Assets

Pre-built alert rules and Grafana dashboards live under `deploy/monitoring/`:

| Path | Purpose |
|------|---------|
| `deploy/monitoring/prometheus/alert-rules.yaml` | Prometheus alert rules (critical + warning) |
| `deploy/monitoring/grafana/dashboards/system-overview.json` | System overview dashboard |
| `deploy/monitoring/grafana/dashboards/agent-loop.json` | Agent loop health dashboard |
| `deploy/monitoring/grafana/dashboards/dlq.json` | DLQ and cursor lag dashboard |
| `deploy/monitoring/grafana/dashboards/latency.json` | HTTP, DB, and event latency dashboard |
| `deploy/monitoring/grafana/provisioning/datasources.yaml` | Grafana datasource provisioning |
| `deploy/monitoring/grafana/provisioning/dashboards.yaml` | Grafana dashboard provisioning |

### Prometheus Configuration

```yaml
rule_files:
  - /etc/prometheus/rules/alert-rules.yaml
```

### Grafana Setup

```bash
cp deploy/monitoring/grafana/provisioning/* /etc/grafana/provisioning/
cp deploy/monitoring/grafana/dashboards/*.json /etc/grafana/dashboards/
```

Grafana will auto-load the dashboards on next restart.

### Logs and Metrics Commands

```bash
# Docker logs
docker logs neurowealth-backend --tail 200 -f

# Kubernetes logs
kubectl logs -l app=neurowealth-backend --tail=200 -f

# Prometheus metrics
curl -sS http://localhost:3001/metrics | head -50
```

---

## Troubleshooting

### Common Issues

| Symptom | Check |
|---------|-------|
| Pod `CrashLoopBackOff` | `kubectl logs deployment/neurowealth-backend -n neurowealth`; verify all required secrets |
| Readiness 503 | `kubectl logs` — DB connection, RPC URL, or background service startup failure |
| Migration initContainer failed | `kubectl logs <pod> -c migrate -n neurowealth` |
| Events not processing | `SELECT * FROM event_cursors;` — cursor lag; ensure only one replica runs the listener |
| Duplicate rebalances | Confirm `replicas: 1`; check agent cron is not running on multiple pods |

### Health and Readiness Commands

```bash
# Liveness — should always return 200 once the process is up
curl -sS http://localhost:3001/health/live | jq .

# Readiness — 200 when all subsystems ready, 503 during startup/shutdown
curl -sS -o /dev/null -w "%{http_code}\n" http://localhost:3001/health/ready

# Detailed subsystem status
curl -sS http://localhost:3001/health/ready | jq .
```

### Database and Migration Commands

```bash
# Check migration status
DATABASE_URL="postgresql://..." npx prisma migrate status

# Apply pending migrations (production-safe, non-destructive)
DATABASE_URL="postgresql://..." npx prisma migrate deploy

# Safe migration + smoke test
DATABASE_URL="postgresql://..." bash scripts/apply-migration.sh

# Verify DB connectivity from the app host
psql "$DATABASE_URL" -c "SELECT 1"
```

### Common Startup Failures

```bash
# Missing or invalid env — app prints all validation errors at once
NODE_ENV=production node dist/index.js

# Verify required production vars are set (no values printed)
env | grep -E '^(NODE_ENV|DATABASE_URL|ADMIN_API_TOKEN|CORS_ORIGINS|JWT_SEED|WALLET_ENCRYPTION_KEY)='

# Stellar network mismatch warning
# Ensure STELLAR_NETWORK=mainnet only when NODE_ENV=production and keys are mainnet
```

### Rate-Limit / Proxy Issues

```bash
# The app trusts one reverse-proxy hop (trust proxy = 1).
# If client IPs look wrong behind CDN + LB, update src/index.ts before redeploying.
curl -H "X-Forwarded-For: 203.0.113.1" http://localhost:3001/health/live
```

---

## CI Validation

Manifests are validated in CI with `kubeconform` (see `.github/workflows/k8s-validate.yml`). Run locally:

```bash
kubeconform -summary deploy/k8s/*.yaml
```

---

## Related Documentation

- `.env.example` — full environment variable reference
- `readme.md` — local development, auth flow, rate limiting
- `Dockerfile` — image build stages and default CMD
- `scripts/apply-migration.sh` — CI/CD migration gate with smoke test
- `docs/RUNBOOK.md` — DLQ replay, cursor management
- `docs/OBSERVABILITY.md` — alerting and metrics