# NeuroWealth Backend

Express + TypeScript REST API for the NeuroWealth platform — AI-assisted portfolio management backed by Stellar smart contracts.

## Documentation

- **API Documentation**: [`docs/openapi.yaml`](docs/openapi.yaml) - Full OpenAPI 3.1 specification
- **SLO Guidance**: [`docs/SLO_GUIDANCE.md`](docs/SLO_GUIDANCE.md) - Latency budgets and performance targets
- **Observability**: [`docs/OBSERVABILITY.md`](docs/OBSERVABILITY.md) - Monitoring and alerting guidance
- **Runbook**: [`docs/RUNBOOK.md`](docs/RUNBOOK.md) - Production operations and incident response
- **Troubleshooting**: [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) - Local development troubleshooting guide

## API Documentation

The full OpenAPI 3.1 specification lives at [`docs/openapi.yaml`](docs/openapi.yaml).

It covers:

| Tag | Base path | Auth |
|---|---|---|
| health | `/health` | None |
| auth | `/api/auth` | None (issues JWT) |
| agent | `/api/agent` | Internal token |
| whatsapp | `/api/whatsapp` | Twilio signature |
| portfolio | `/api/portfolio` | Bearer JWT |
| transactions | `/api/transactions` | Bearer JWT |
| protocols | `/api/protocols` | None |
| deposit | `/api/deposit` | Bearer JWT |
| withdraw | `/api/withdraw` | Bearer JWT |
| vault | `/api/vault` | Mixed (public + Bearer JWT) |
| analytics | `/api/analytics` | Mixed (public + Bearer JWT) |
| stellar | `/api/stellar` | None |
| admin | `/api/admin` | Admin API key (Bearer or `X-Admin-Token`) |
| metrics | `/metrics` | Internal token (strict) |

### Viewing the docs

**Swagger UI** (available when the server is running):

| URL | Description |
|---|---|
| `http://localhost:3000/api/v1/docs` | Interactive API explorer |
| `http://localhost:3000/docs` | Alias for the above |
| `http://localhost:3000/api/v1/openapi.yaml` | Raw spec YAML |
| `http://localhost:3000/openapi.yaml` | Alias for the above |

### Validating the spec

```bash
npm run validate:spec
```

### Updating the spec

When you add or change a route, update `docs/openapi.yaml` in the same PR. Run `npm run validate:spec` to ensure the spec is valid before committing. The `prebuild` step also validates and copies the spec to `dist/docs/openapi.yaml` as a build artifact.

### Breaking-change policy

This API follows semantic versioning. Breaking changes (removed fields, changed response shapes, new required parameters) increment the major version and are announced at least two weeks before release.

## Development

```bash
cp .env.example .env
npm install
npm run dev
```

**Troubleshooting**: If you encounter issues during setup, see the [Troubleshooting Guide](docs/TROUBLESHOOTING.md) for common problems and solutions.

## Running tests

```bash
npm test
```

## Smoke test

Run a health-check smoke test against a running server:

```bash
npm run smoke
```

`smoke:health` is also available as a named alias for the startup health check. Both run the same script.
