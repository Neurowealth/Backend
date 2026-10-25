# Backend release checklist and deployment gates (#516)

Record the release commit SHA, target environment, risk tier, release owner,
approvers, CI run links, rollback artifact, and staging evidence in the release
record. All tiers require successful preflight and post-rollout verification.
Choose the highest tier touched by a change.

| Tier         | Changes                                                                 | Required sign-off                     | Additional evidence                                                     |
| ------------ | ----------------------------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------- |
| 1 — Low      | Stateless fixes, documentation, minor refactors                         | One backend peer                      | Preflight CI result                                                     |
| 2 — Medium   | API additions, non-blocking migrations, new features                    | Backend peer and QA                   | Rollback rehearsal and feature/contract test results                    |
| 3 — High     | Financial/treasury logic, authorization, high-throughput outbox changes | Tech Lead and Security Lead           | 24-hour staging soak, verified backup, rollback rehearsal               |
| 4 — Critical | Breaking schemas, Soroban upgrades, wallet key rotations                | Tech Lead, DevOps Lead, Security Lead | Executed rollback rehearsal, upgrade/key recovery plan, verified backup |

## Before deployment

- [ ] Release scope, commit, tier, owner, and sign-offs recorded.
- [ ] Checkout is clean, including untracked files. Commit reviewed changes first.
- [ ] Dependencies installed and Prisma client generated (`npm ci`, `npm run prisma:generate`).
- [ ] Pending migrations reviewed and applied to a **disposable or staging database**.
      Set `DATABASE_URL` to that database for preflight. Do not apply production
      migrations merely to satisfy a preflight status check.
- [ ] Run `npm run release:preflight`.

Preflight stops on the first failure: dirty checkout, environment template parity,
formatting, lint, typecheck, OpenAPI lint, migration status, missing rollback files,
the default Jest suite, or production build. It does not apply migrations.
Migration status errors, including connectivity errors and unapplied migrations,
are fatal. OpenAPI lint validates the specification, not correspondence with runtime
handlers; migration status is not a complete schema drift audit.

The default Jest configuration excludes several database integration suites.
Attach results from applicable excluded suites separately, using the suite's documented
setup and a disposable database. A default Jest pass is not evidence that every
integration test ran.

## Database and human safety gates

For Tier 2–4, record the following evidence before approval:

- [ ] Recent production backup identified and restore procedure verified.
- [ ] SQL reviewed for locking, data loss, and compatibility with old/new application versions.
- [ ] Run `bash scripts/rehearse-migration-rollback.sh` against a disposable database;
      attach its output. Never point a rehearsal at production.
- [ ] Configuration, secret validity, network selection, and feature flags reviewed.
- [ ] RPC primary/fallback behavior and relevant financial/auth flows tested in staging.
- [ ] Required reviewers explicitly signed off on this release SHA.

The existing migration rollback workflow checks rollback files and rehearses migrations
when its path filters match. Link the appropriate successful run; documentation alone
is not rehearsal evidence.

## Deployment and verification

1. Complete preflight, tier-specific checks, and approvals.
2. Apply reviewed production migrations using the migration runbook and preserve the
   backup/rollback artifacts. Use compatible expand/contract migrations for rolling updates.
3. Roll out the release to staging or an isolated production canary. Confirm workers,
   schedulers, and event listeners are running.
4. Set `INTERNAL_SERVICE_TOKEN` securely in the environment, then run:

   ```bash
   npm run release:verify -- https://YOUR-CANARY-HOST
   ```

   Use HTTPS for remote environments. The script checks the existing API:

   - `/health`: HTTP 200 and `status: ok`.
   - `/health/ready`: HTTP 200, `ready: true`, and all four required subsystems ready.
   - `/health/deep`: authenticated HTTP 200, `status: healthy`, and healthy database,
     Stellar RPC, Twilio, and agent-loop checks. Degraded responses fail.

   Missing credentials, transport errors, redirects, invalid JSON, missing fields,
   and unhealthy responses fail verification. Each of the three sequential requests
   has a 10-second timeout (approximately 30 seconds total plus process overhead).
   Node.js and curl are required. Response bodies and tokens are not printed.

5. Complete checks that the current health API **does not expose**:
   - [ ] Redis connectivity and application Redis error metrics checked.
   - [ ] Outbox backlog age, retries, and throughput compared with the recorded baseline
         and the release's agreed threshold; no growing unprocessed backlog.
   - [ ] Business-critical smoke tests and applicable excluded integration suites passed.
6. Promote traffic only after verification and manual checks pass. Monitor for at least
   30 minutes and record outcomes.

## CI and environment configuration

Node CI invokes release tooling regression tests and `release:preflight` after creating
and migrating its disposable database. Configure branch protection to require this CI
job and the applicable migration/API checks.

`release-verification.yml` invokes `release:verify` on successful GitHub deployment
statuses for `staging` and `production`, or by manual dispatch. Configure each GitHub
environment with:

- `RELEASE_TARGET_URL` variable pointing to the actual isolated deployment being checked.
- `INTERNAL_SERVICE_TOKEN` secret matching the deployed application's token.
- Required reviewers and deployment branch restrictions appropriate to the release tier.

GitHub environment protection and branch protection must be configured in repository
settings; committing workflow YAML does not enable them. A deployment-status check runs
**after** rollout and does not itself block routing or roll back infrastructure. The
external deployment controller must keep canary traffic isolated, publish the deployment
status, wait for the verification result, and require the release record's human sign-offs
before promotion. This repository does not contain that controller. Risk tiers, reviewer
counts, and the 24-hour soak are human gates, not automatically enforced by these scripts.

## Emergency rollback

Rollback triggers during the observation window:

- HTTP 5xx rate above 0.5%.
- p95 latency exceeding twice the recorded baseline or the agreed release SLO.
- Continuously growing outbox backlog, database deadlocks, or pool exhaustion.
- Failed readiness, unhealthy dependencies, or failed critical business smoke tests.

Stop promotion and route traffic back to the previous healthy version. Revert the
application deployment using the target environment's runbook. Roll back database
changes only after confirming compatibility and data-loss implications with the
rehearsed recovery plan; do not blindly reverse migrations still used by live nodes.
Notify the incident lead and record the triggering metrics, actions, and recovery checks.
