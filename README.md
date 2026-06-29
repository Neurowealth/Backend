# NeuroWealth Backend

Express + TypeScript REST API for the NeuroWealth platform — AI-assisted portfolio management backed by Stellar smart contracts.

## API Documentation

The full OpenAPI 3.1 specification lives at [`docs/openapi.yaml`](docs/openapi.yaml).

It covers:

| Tag | Base path | Auth |
|---|---|---|
| health | `/health` | None |
| auth | `/api/auth` | None (issues JWT) |
| portfolio | `/api/portfolio` | Bearer JWT |
| transactions | `/api/transactions` | Bearer JWT |
| deposit | `/api/deposit` | Bearer JWT |
| withdraw | `/api/withdraw` | Bearer JWT |
| vault | `/api/vault` | Bearer JWT |
| admin | `/api/admin` | `X-Admin-Token` header |

### Viewing the docs locally

```bash
npx @redocly/cli preview-docs docs/openapi.yaml
```

### Updating the spec

When you add or change a route, update `docs/openapi.yaml` in the same PR. The `api-contract` CI job will lint the spec and run smoke tests automatically.

### Breaking-change policy

This API follows semantic versioning. Breaking changes (removed fields, changed response shapes, new required parameters) increment the major version and are announced at least two weeks before release.

## Development

```bash
cp .env.example .env
npm install
npm run dev
```

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
