# Production deployment, secrets, and migrations

This guide covers secret management, CI/CD injection, database migrations, health/readiness checks, and rollback for the NeuroWealth backend.

## Secret managers (recommended)

| Provider | Best for | Notes |
|----------|----------|-------|
| **AWS Secrets Manager** | AWS-hosted production | Automatic rotation hooks; inject via ECS task secrets or Lambda env |
| **HashiCorp Vault** | Multi-cloud / on-prem | Dynamic secrets, audit trail; use AppRole or K8s auth |
| **GitHub Actions secrets** | CI/CD and staging | Store `DATABASE_URL`, `JWT_SEED`, etc. per environment; never log values |

Never commit raw secrets. Use `.env.example` as a template only.

## Required production secrets

| Variable | Purpose | Rotation |
|----------|---------|----------|
| `JWT_SEED` | Signs session JWTs (64-hex) | Every 90 days; invalidate all sessions on rotate |
| `WALLET_ENCRYPTION_KEY` | Encrypts stored wallet material (32-byte hex) | Coordinated re-encryption migration required |
| `STELLAR_AGENT_SECRET_KEY` | On-chain agent signing (56-char `S…` key) | Generate new keypair, fund, update env, drain old key |
| `DATABASE_URL` | PostgreSQL connection | Rotate DB password in provider; update URL; restart app |
| `ANTHROPIC_API_KEY` | AI agent | Rotate in Anthropic console; update secret store |

Generate locally (development only):

```bash
openssl rand -hex 64   # JWT_SEED
openssl rand -hex 32   # WALLET_ENCRYPTION_KEY
```

### JWT_SEED rotation

1. Generate a new 64-hex value and store it in your secret manager.
2. Deploy with the new `JWT_SEED` during a maintenance window.
3. All existing sessions become invalid; users re-authenticate via Stellar challenge.
4. Monitor auth error rates and `/api/auth` traffic.

### WALLET_ENCRYPTION_KEY rotation

1. Provision `WALLET_ENCRYPTION_KEY_NEW` alongside the current key.
2. Run a one-off migration job that decrypts with the old key and re-encrypts with the new key.
3. Swap env to the new key only after verification.
4. Remove the old key from the secret store.

### STELLAR_AGENT_SECRET_KEY rotation

1. Create and fund a new Stellar keypair on the target network.
2. Update contract/agent permissions if your vault requires an allowlist.
3. Set `STELLAR_AGENT_SECRET_KEY` in the secret manager and redeploy.
4. Verify agent loop and deposit/withdraw paths on testnet before mainnet.

## CI/CD secret injection

- Map GitHub Environment secrets (`staging`, `production`) to job `env` blocks.
- Use OIDC to AWS/GCP where possible instead of long-lived access keys.
- Restrict `workflow_dispatch` and production deploy jobs to protected branches.
- The `migration-smoke` CI job validates `npx prisma migrate deploy` + `npm run smoke` before release promotion.

Example (GitHub Actions):

```yaml
env:
  DATABASE_URL: ${{ secrets.DATABASE_URL }}
  JWT_SEED: ${{ secrets.JWT_SEED }}
  WALLET_ENCRYPTION_KEY: ${{ secrets.WALLET_ENCRYPTION_KEY }}
  STELLAR_AGENT_SECRET_KEY: ${{ secrets.STELLAR_AGENT_SECRET_KEY }}
```

## Deploy checklist (use at every release)

### Pre-deploy

- [ ] Review pending Prisma migrations (`npx prisma migrate status`)
- [ ] Confirm migration SQL is non-destructive or has a documented data backfill
- [ ] Take a database backup/snapshot (provider console or `pg_dump`)
- [ ] Schedule during low traffic; notify on-call
- [ ] Staging deploy passed CI (`migration-smoke` job green)

### Deploy (roll-forward)

1. **Backup** — snapshot or `pg_dump` of production DB.
2. **Apply migrations** — use the safe script (non-interactive in CI):

   ```bash
   export DATABASE_URL="postgresql://..."
   CI=1 bash scripts/apply-migration.sh
   ```

   Or manually:

   ```bash
   npx prisma migrate deploy
   npm run smoke
   ```

3. **Smoke test** — `npm run smoke` must exit 0 (connectivity + core tables).
4. **Deploy application** — roll out new containers/instances with updated image.
5. **Promote traffic** — only after health checks pass (see below).

### Post-deploy verification

- [ ] `GET /health` returns 200
- [ ] Readiness subsystems show `database`, `eventListener`, `agentLoop` ready
- [ ] No spike in DLQ size (`dead_letter_events` table)
- [ ] Monitor logs (Winston → CloudWatch/Datadog/etc.)

## Health and readiness

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Liveness; returns subsystem readiness from `src/config/readiness.ts` |
| Load balancer | Use readiness: return 503 until `database` (and optionally `eventListener`) are marked ready |

If the event listener fails to start, the API may still serve read-only routes but on-chain ingestion will lag—treat sustained DLQ growth as a rollback trigger.

## Migration rollback

Prisma does not auto-reverse `migrate deploy`. Plan rollbacks explicitly:

### When to rollback

- `migrate deploy` or `npm run smoke` fails in CI or production
- Application errors correlated with a specific migration
- Data integrity issues in `processed_events`, `transactions`, or `positions`

### Roll-forward vs rollback

| Situation | Action |
|-----------|--------|
| Migration applied, app bug only | Roll back **application** image to previous tag; DB unchanged |
| Bad migration, no data loss yet | Restore DB from pre-deploy snapshot; redeploy previous app + migration set |
| Bad migration with partial writes | Restore snapshot; replay DLQ after fix; document manual reconciliation |

### Rollback steps

1. Stop traffic to new instances (drain load balancer).
2. Restore database from the pre-deploy backup/snapshot.
3. Deploy the **previous** application image (matching the restored schema).
4. Run `npm run smoke` against the restored DB.
5. Re-enable traffic; post-mortem and fix-forward migration in a new release.

## Automated checks in CI

The `migration-smoke` workflow job:

1. Spins up an isolated Postgres service
2. Runs `npx prisma migrate status` and `npx prisma migrate deploy`
3. Fails if pending migrations remain after deploy
4. Runs `npm run smoke`

A failing job blocks merge/deploy—treat it as the migration alert for staging.

## Related files

- `scripts/apply-migration.sh` — interactive checklist + migrate + smoke (for operators)
- `scripts/smoke-test.ts` — minimal schema connectivity test
- `.github/workflows/node-ci.yml` — `migration-smoke` job
- `docs/DEPLOYMENT_GUIDE.md` — vault event listener operational notes
