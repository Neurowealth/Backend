# Internal Endpoints Documentation

## Authentication

Internal endpoints require the `X-Internal-Token` header:

```bash
curl -H "X-Internal-Token: $INTERNAL_SERVICE_TOKEN" http://localhost:3000/api/stellar/metrics
```

## Protected Endpoints

### Metrics (`/api/stellar/metrics`)
Returns Stellar event processing metrics from Prometheus.

```bash
curl -H "X-Internal-Token: $INTERNAL_SERVICE_TOKEN" http://localhost:3000/api/stellar/metrics
```

### Agent Status (`/api/agent/status`)
Returns current agent health and status information.

```bash
curl -H "X-Internal-Token: $INTERNAL_SERVICE_TOKEN" http://localhost:3000/api/agent/status
```

## Environment Setup

Set `INTERNAL_SERVICE_TOKEN` in your `.env` file:

```bash
INTERNAL_SERVICE_TOKEN=sk-internal-your-secret-token-here
```

For production, use a secure random token.
