# Health Endpoints Matrix

The production-smoke GitHub Actions workflow starts the built artifact and
requires both `GET /health` and `GET /health/ready` to return 200. The readiness
probe covers database, Stellar network configuration, event listener, and
agent-loop startup dependencies. Locally, run `npm run smoke` after building
and applying migrations; set `SMOKE_READINESS_PATH` only when a deployment uses
a different readiness path.

Comprehensive reference for all health check endpoints. Use this matrix to choose the right probe for your environment (local dev, CI, production).

---

## Quick Reference Table

| Endpoint | Probe Type | Response | Dependencies | Latency | Use Case |
|----------|-----------|----------|--------------|---------|----------|
| `GET /health` | Liveness | 200 always | None | <1ms | Basic app liveness |
| `GET /health/live` | Shallow liveness | 200 always | None | <1ms | K8s liveness probe, load balancer keepalive |
| `GET /health/ready` | Deep readiness | 200/503 | DB, Event Listener, Agent Loop | 10-100ms | K8s readiness probe, traffic routing |

---

## Endpoint Descriptions

### `GET /health`

**Purpose:** Minimal liveness check — app is running and responding.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2026-06-24T10:30:00.000Z",
  "version": "1.0.0",
  "environment": "production"
}
```

**Status Code:** Always `200`

**Dependencies checked:** None (HTTP server only)

**Latency:** <1 millisecond

**When to use:**
- Local dev: Quick sanity check that the server is up
- CI: Smoke test in deployment scripts
- Production: Load balancer keepalive, basic uptime monitoring

**Shallow probe:** Yes — no subsystem checks

**Example:**
```bash
curl http://localhost:3001/health
```

---

### `GET /health/live`

**Purpose:** Kubernetes liveness probe — container is running (not stuck or crashed).

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2026-06-24T10:30:00.000Z",
  "version": "1.0.0",
  "environment": "production"
}
```

**Status Code:** Always `200`

**Dependencies checked:** None (HTTP server only)

**Latency:** <1 millisecond

**When to use:**
- K8s: Set as `livenessProbe` in Deployment — kubelet restarts if this fails
- Not for traffic routing decisions

**Shallow probe:** Yes — no subsystem checks

**Example:**
```bash
# K8s Deployment livenessProbe
livenessProbe:
  httpGet:
    path: /health/live
    port: 3001
  initialDelaySeconds: 10
  periodSeconds: 10
```

---

### `GET /health/ready`

**Purpose:** Kubernetes readiness probe and load balancer health check — all critical subsystems operational.

**Response on ready (200):**
```json
{
  "ready": true,
  "subsystems": {
    "database": true,
    "eventListener": true,
    "agentLoop": true
  },
  "timestamp": "2026-06-24T10:30:00.000Z"
}
```

**Response on not ready (503):**
```json
{
  "ready": false,
  "subsystems": {
    "database": true,
    "eventListener": false,
    "agentLoop": true
  },
  "timestamp": "2026-06-24T10:30:00.000Z"
}
```

**Status Code:**
- `200 OK` — All subsystems ready
- `503 Service Unavailable` — One or more subsystems not ready

**Dependencies checked:**

1. **`database`** — PostgreSQL connectivity and schema ready
   - Checked at startup
   - Marked ready after Prisma migrations complete
   - Set to false on connection loss

2. **`eventListener`** — Stellar event ingestion running
   - Marked ready after listener connects to Stellar RPC and starts processing
   - Set to false if event processing loop crashes

3. **`agentLoop`** — Agent rebalance loop running
   - Marked ready after agent tasks are scheduled
   - Set to false if scheduled task fails

**Latency:** 10-100 milliseconds (depends on subsystem health checks)

**When to use:**
- K8s: Set as `readinessProbe` in Deployment — traffic only routes to ready pods
- Load balancer: Health check before sending requests
- Startup scripts: Wait for readiness before running integration tests
- Production incident triage: Identify which subsystem is down

**Deep probe:** Yes — checks all critical subsystems

**Example:**
```bash
# K8s Deployment readinessProbe
readinessProbe:
  httpGet:
    path: /health/ready
    port: 3001
  initialDelaySeconds: 30
  periodSeconds: 5
  failureThreshold: 3

# Usage: wait for readiness in scripts
until curl -f http://localhost:3001/health/ready > /dev/null 2>&1; do
  sleep 1
done
echo "Service ready"
```

---

## Dependency Graph

```
┌─────────────────┐
│  GET /health    │  (Liveness)
│  GET /health/   │
│  live           │  ✓ App responds
└─────────────────┘
         ▲
         │
         ▼
  ┌─────────────────┐
  │ GET /health/    │  (Readiness)
  │ ready           │
  ├─────────────────┤
  │ Subsystems:     │
  │ • database      │ ┐
  │ • eventListener │ ├─→ All must be `true` → HTTP 200
  │ • agentLoop     │ ┘
  └─────────────────┘
```

### Shallow vs Deep Probes

| Probe Type | Endpoints | What it checks | Use case |
|-----------|-----------|----------------|----------|
| **Shallow** | `/health`, `/health/live` | HTTP server responds | Liveness, not safety |
| **Deep** | `/health/ready` | DB, event listener, agent loop | Readiness, traffic routing |

---

## Startup Boot Sequence

```
1. HTTP server starts listening
   → /health and /health/live return 200 immediately
   → /health/ready returns 503 (all subsystems not ready)

2. Database connects and migrations complete
   → markReady('database')
   → database subsystem = true

3. Event listener connects to Stellar RPC and starts processing
   → markReady('eventListener')
   → eventListener subsystem = true

4. Agent loop tasks scheduled
   → markReady('agentLoop')
   → agentLoop subsystem = true
   → /health/ready returns 200 when all are true

5. Load balancer / K8s sends traffic
```

---

## Environment-Specific Recommendations

### Local Development

```bash
# Quick sanity check
curl http://localhost:3001/health

# Wait for full readiness (before running integration tests)
until curl -f http://localhost:3001/health/ready > /dev/null 2>&1; do
  echo "Waiting for service..."
  sleep 1
done
echo "Service ready!"
```

### CI/CD Deployment

```bash
#!/bin/bash
# Deploy script checks
docker run -d --name app neurowealth-backend:latest
sleep 5

# Verify HTTP server is up
curl -f http://localhost:3001/health || exit 1

# Wait for readiness (with timeout)
timeout 120 bash -c 'until curl -f http://localhost:3001/health/ready > /dev/null 2>&1; do sleep 2; done' || {
  echo "Service failed to become ready"
  docker logs app
  exit 1
}

echo "Deployment successful"
```

### Production / Kubernetes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: neurowealth-backend
spec:
  template:
    spec:
      containers:
      - name: app
        image: neurowealth-backend:latest
        ports:
        - containerPort: 3001

        # Liveness: restart if process hangs
        livenessProbe:
          httpGet:
            path: /health/live
            port: 3001
          initialDelaySeconds: 10
          periodSeconds: 10
          timeoutSeconds: 5
          failureThreshold: 3

        # Readiness: only route traffic to ready pods
        readinessProbe:
          httpGet:
            path: /health/ready
            port: 3001
          initialDelaySeconds: 30
          periodSeconds: 5
          timeoutSeconds: 3
          failureThreshold: 2
```

---

## Monitoring & Alerting

### Metrics to track

- `/health/live` response time (should be <5ms)
- `/health/ready` response time (should be <100ms)
- `/health/ready` `false` rate (should be 0% in steady state)
- Time from `/health/live` first responding to `/health/ready` responding (should be <2 min on startup)

### Alert Examples

```yaml
- alert: HealthCheckFailing
  expr: increase(http_requests_total{path="/health/live",status_code!="200"}[5m]) > 0
  annotations:
    summary: "Health check failing"
    description: "{{ $labels.instance }} health check is not returning 200"

- alert: ServiceNotReady
  expr: increase(http_requests_total{path="/health/ready",status_code="503"}[1m]) > 0
  annotations:
    summary: "Service not ready"
    description: "{{ $labels.instance }} readiness probe failing"
```

---

## Incident Triage

When `/health/ready` returns 503, check which subsystem is false:

```bash
# Get detailed status
curl http://localhost:3001/health/ready | jq '.subsystems'

# Output tells you what to investigate:
# { "database": false, ... }      → Check DB connectivity, migrations
# { "eventListener": false, ... } → Check Stellar RPC, event ingestion logs
# { "agentLoop": false, ... }     → Check agent loop scheduler, logs

# Full logs for debugging
tail -f logs/combined.log | grep -E "database|eventListener|agentLoop"
```

---

## API Contract (OpenAPI)

See [`docs/openapi.yaml`](./openapi.yaml) for full spec under the `health` tag.
