# Database Migrations — Process, Validation and Rollback

Repeatable process for safe schema changes, migration validation, and rollback
strategy (#470).

This document is the canonical reference. `docs/DEPLOYMENT.md` covers the
environment matrix and deployment mechanics; this document covers the *schema
change* process specifically. Where the two previously disagreed (snapshot-only
rollback vs. `rollback.sql`), this document is authoritative.

**Scripts**

| Script | Purpose |
|---|---|
| `scripts/apply-migration.sh` | Applies pending migrations with a pre-flight checklist, then smoke-tests |
| `scripts/rollback-migration.sh` | Reverses one migration using its `rollback.sql` |
| `scripts/check-migration-rollback.sh` | CI gate: every migration must ship a `rollback.sql` |
| `scripts/rehearse-migration-rollback.sh` | Fingerprints the schema, applies → rolls back → re-applies, and proves the round trip — without touching migration history |

---

## 1. The repeatable process

Every schema change follows the same five phases. No phase is optional, and a
phase may not start until the previous one is green.

1. **Classify** the change (§2) — this determines the required backups and whether
   the change may ship in a rolling deploy.
2. **Author** `migration.sql` *and* `rollback.sql` together (§3).
3. **Validate** locally and in CI (§4).
4. **Rehearse** the rollback (§5) — the recovery path is proven before production.
5. **Apply** to staging, then production, with the pre-flight checklist (§6).

### Non-negotiables

- **No `prisma migrate dev` against production.** `migrate dev` is for local
  development only; it may reset the database. Production uses
  `prisma migrate deploy` exclusively.
- **No `migrate reset` in staging or production.** It drops the database.
- **`migration.sql` and `rollback.sql` land in the same commit.** A migration
  without a rollback does not merge (see §7).
- **Every migration is forward-only.** There is no `migrate down`. The
  `rollback.sql` file is the down.

---

## 2. Change classification

Classify every migration before writing it. The classification drives the
backup requirement, the deployment strategy, and the rollback tier.

| Class | Examples | Lock behaviour | Backup | Deploy strategy |
|---|---|---|---|---|
| **A — Metadata only** | Add a nullable column with no default; add a table; add an index **concurrently**; add an enum value via `ALTER TYPE ... ADD VALUE` | `ACCESS EXCLUSIVE` held briefly, or none with `CONCURRENTLY` | Standard pre-deploy snapshot | Rolling deploy, any order |
| **B — Blocking DDL** | Add a non-null column with a default; add a foreign key (validated); change a column type; add a unique constraint | `ACCESS EXCLUSIVE` for the duration of the table rewrite | Verified snapshot + `pg_dump` | Single-instance deploy or drain traffic |
| **C — Backfill** | `UPDATE` over a large table; `NOT NULL` after a backfill | `ROW EXCLUSIVE` (blocks writes, not reads) for the duration | Verified snapshot + `pg_dump` | Drain traffic; run as a job, not in the migration |
| **D — Irreversible** | Drop a column holding data; drop a table; lossy type narrowing | `ACCESS EXCLUSIVE` | Verified snapshot + `pg_dump`; **confirm restore is tested** | Drain traffic; two-phase deploy |

### Rules that follow from the classification

- **Never mix classes in one migration.** A metadata-only migration can ship in
  any deploy; a backfill cannot. Separate them so a rollback of one does not
  require undoing the other.
- **Expand / migrate / contract.** For class C and D changes to a live table,
  ship three releases: *expand* (add the new column, nullable), *migrate*
  (backfill + dual-write), *contract* (drop the old column, in a later release
  once no application version reads it). Never expand and contract in one step.
- **Add indexes with `CREATE INDEX CONCURRENTLY`.** A plain `CREATE INDEX` takes
  a write lock for the whole build. Note that `CONCURRENTLY` cannot run inside a
  transaction — write that migration outside Prisma's implicit transaction and
  note it in the file header.
- **Backfills belong in `scripts/`, not in `migration.sql`.** A `migration.sql`
  that rewrites millions of rows holds a lock for the length of the backfill and
  makes the migration's runtime unbounded. Use the existing pattern:
  `scripts/backfill-*.ts`.

### Downtime impact assessment

Every PR that changes the schema must state its downtime impact explicitly. Use
this block verbatim in the PR description:

```markdown
### Downtime impact
- **Class:** A | B | C | D
- **Locks taken:** <ACCESS EXCLUSIVE / ROW EXCLUSIVE / none>
- **Expected lock duration:** <e.g. ~40ms for the metadata change on 12k rows>
- **Writes blocked during migration:** yes | no
- **Requires traffic drain:** yes | no
- **Rollback tier:** app-only | rollback.sql | snapshot restore
```

> **WARNING:** `ACCESS EXCLUSIVE` is also taken by `ALTER TABLE`, `DROP COLUMN`,
> and `CREATE INDEX` *without* `CONCURRENTLY`. On a large table these block all
> reads and writes for the duration of the statement. If the affected table is on
> the request path, the change is class B or D and requires a drain.

---

## 3. Authoring the migration

### Layout

```
prisma/migrations/<YYYYMMDDHHMMSS>_<snake_case_topic>/
├── migration.sql    # the change
└── rollback.sql     # the reverse of the change  (mandatory)
```

Use a 14-digit timestamp. Two migrations created on the same day must not share
a timestamp — Prisma orders migrations lexicographically, so a collision produces
a non-deterministic order.

### `migration.sql` header

State what the change does, why, which issue it belongs to, and any hazard the
reviewer must check:

```sql
-- Migration: add_<topic> (#NNN)
-- One-line purpose.
-- WARNING: <lock held, irreversible step, or required deployment order>
```

### `rollback.sql` header

The existing house style, which the runbook and reviewers rely on:

```sql
-- rollback.sql — reverse of <dir>/migration.sql
-- What it drops/recreates.
-- WARNING: DATA LOSS — <what is permanently lost> (#NNN).
-- Documented as partially irreversible because <reason>.
-- Safe to run multiple times.
-- Run with: psql $DATABASE_URL -f prisma/migrations/<dir>/rollback.sql

DROP INDEX IF EXISTS "...";
ALTER TABLE "..." DROP COLUMN IF EXISTS "...";
```

### Rules for `rollback.sql`

- **Be idempotent.** Use `IF EXISTS` / `IF NOT EXISTS` throughout. The rollback
  script runs the file in a single transaction, and an operator may re-run it
  after a partial failure.
- **Document data loss explicitly.** A `WARNING: DATA LOSS` line is mandatory for
  any `DROP` of a column that held data.
- **Document partial irreversibility.** If a step can fail because of data
  written after the migration, say so and name the check the operator must run
  first. See
  `prisma/migrations/20260617000000_fix_agent_log_attribution/rollback.sql` for
  the reference example: it cannot re-apply `NOT NULL` while null rows exist, and
  the file says so.
- **Recreate what was dropped.** If `migration.sql` dropped a column that another
  table's constraint referenced, the rollback must restore the dependency order.
- **Rollbacks do not need to restore dropped data.** Restoring data is a snapshot
  restore (§6, tier 3), not a `rollback.sql` responsibility. Say so.

---

## 4. Validation

### Locally

```bash
# 1. The change is generated correctly and the client still builds
npx prisma migrate dev --name <topic>   # local DB only — never against staging/prod
npx prisma generate
npm run typecheck

# 2. The rollback actually reverses the change
bash scripts/rehearse-migration-rollback.sh

# 3. The full suite is green against the migrated schema
npm test
```

The rehearsal in step 2 is the step that catches a broken `rollback.sql`. Do not
skip it: a rollback that has never been executed is a hypothesis, not a plan.

### In CI

| Job | Gate |
|---|---|
| `Require rollback.sql per migration` (`.github/workflows/migration-rollback-check.yml`) | Every `migration.sql` has a `rollback.sql` |
| `Rollback rehearsal` (same workflow) | Applies → rolls back → re-applies the newest migration against a real PostgreSQL |
| `Migration smoke test` (`.github/workflows/node-ci.yml`) | `migrate deploy` leaves no pending migrations; the app boots and serves `/health` |
| `ci` (`.github/workflows/node-ci.yml`) | Lint, format, build and the full test suite run against the migrated schema |

> **WARNING:** the `Rollback rehearsal` job runs `rollback.sql` files. It is
> pinned to an ephemeral PostgreSQL service container that exists only for the
> job. The script refuses to run against a database whose name looks like
> production — see §5.

---

## 5. Rollback rehearsal

The recovery path is tested, not assumed. The rehearsal proves that
`scripts/rollback-migration.sh` and the newest `rollback.sql` work together
before either is needed for real.

```bash
# Against a throwaway database (CI does this automatically)
DATABASE_URL=postgresql://user:pass@localhost:5432/rehearsal_db \
  bash scripts/rehearse-migration-rollback.sh

# Point it at staging to rehearse against a production-shaped database
DATABASE_URL=postgresql://user:pass@staging-host:5432/neurowealth_staging \
  bash scripts/rehearse-migration-rollback.sh
```

The rehearsal:

1. Applies all pending migrations so the database is at head.
2. Selects the newest applied migration and checks it ships both a
   `rollback.sql` and a `migration.sql`.
3. Fingerprints the schema, applies `rollback.sql`, and asserts the fingerprint
   **changed** — a `rollback.sql` that reverts nothing looks like a working
   recovery path during an incident while actually reverting nothing.
4. Re-applies `migration.sql` and asserts the fingerprint matches the original
   exactly.
5. Confirms `prisma migrate status` is clean.

It never writes to `_prisma_migrations`, so the database is left exactly as it
was found. That is deliberate: marking a migration as rolled back and relying on
`prisma migrate deploy` to restore it depends on Prisma 5's history semantics,
which are not a round trip (`migrate resolve --rolled-back` refuses outright
with `P3012` for a migration that applied successfully). Every failure mode in
that path has the same nasty property — the columns are gone, the history still
says "applied", and the next deploy is a silent no-op — so the rehearsal
verifies the SQL itself instead of the bookkeeping.

A rehearsal against staging is safe: the newest migration is reversed and then
immediately re-applied, leaving the schema identical to its starting state. Run
it after a production apply as well as before — it confirms the rollback path is
still intact against the current schema.

> **WARNING:** the rehearsal reverses a migration on the target database. Run it
> against staging freely. Do not run it against production without a maintenance
> window — step 3 drops whatever the newest migration created.

---

## 6. Applying a migration

### Pre-flight checklist

Complete every item. `scripts/apply-migration.sh` prints the first five as a
reminder, but the review items are the author's responsibility.

**Review**

- [ ] `npx prisma migrate status` — the set of pending migrations is the set
      expected, and nothing unrelated has drifted in
- [ ] The change is classified (§2) and the class is recorded in the PR
- [ ] `migration.sql` has been read line by line; every statement is understood
- [ ] `rollback.sql` exists, has been rehearsed, and its data-loss warnings are
      accurate
- [ ] No `DROP TABLE` / `DROP COLUMN` on a table that still receives writes from
      a deployed application version
- [ ] Added columns are nullable or defaulted, so the previous application
      version keeps working during a rolling deploy
- [ ] New indexes use `CONCURRENTLY` on tables on the request path
- [ ] Lock held and its expected duration are written in the PR

**Backup**

- [ ] A snapshot exists from within the last hour, and its identifier is recorded
      in the PR
- [ ] For class C and D, a `pg_dump` also exists (`pg_dump --format=custom
      --file=pre-migration.dump "$DATABASE_URL"`) — a provider snapshot alone is
      not sufficient for a verified restore
- [ ] The snapshot restore path is known: which snapshot, how to restore, and how
      long it takes
- [ ] `DATABASE_URL` points at the intended environment, verified by printing the
      host and database name

**Downtime**

- [ ] Downtime impact block is filled in (§2)
- [ ] If writes are blocked, a low-traffic window is scheduled and on-call is
      notified
- [ ] If traffic must be drained, the drain procedure is written down and the
      person running it has done it before
- [ ] `lock_timeout` is set for the apply session so a blocked migration fails
      fast instead of queueing behind open transactions

**Rollback readiness**

- [ ] The rollback tier is chosen (§6.1) and the commands are copied into the
      deploy ticket
- [ ] Whoever is on call for the window knows they are authorised to run
      `scripts/rollback-migration.sh`

### 6.1 Choosing a rollback tier

| Tier | Use when | Mechanism | Data impact | Time to recover |
|---|---|---|---|---|
| **1 — Application only** | The migration is correct; the application code that shipped with it is wrong | Redeploy the previous image. The schema is unchanged, so no `rollback.sql` runs. | None | Minutes |
| **2 — `rollback.sql`** | The migration itself is the problem: a bad constraint, a wrong index, a failed backfill | `scripts/rollback-migration.sh <migration>` | Structure reverted; rows written *after* the migration are lost for dropped columns | Minutes |
| **3 — Snapshot restore** | The migration caused data loss or corruption, or the rollback is documented as partially irreversible | Restore the pre-deploy snapshot, redeploy the previous image, reconcile | Everything written after the snapshot is lost | Hours |

Default to tier 1. Escalate to tier 2 only when the schema is the fault. Tier 3
is the last resort and requires a data-reconciliation plan for anything written
after the snapshot.

> **WARNING:** tier 2 and tier 3 are not equivalent. Running `rollback.sql`
> against a production database that has already accepted writes discards those
> writes if the migration dropped a column. This is why the rehearsal is
> mandatory and why the backup checklist above is not advisory.

### Applying

```bash
# Review what will run
npx prisma migrate status
npx prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma \
  --script | less

# Apply, with a fail-fast lock timeout
PGOPTIONS='-c lock_timeout=5s -c statement_timeout=120s' \
  DATABASE_URL="$DATABASE_URL" bash scripts/apply-migration.sh
```

`scripts/apply-migration.sh` runs `prisma migrate deploy`, then
`npm run smoke`, and exits non-zero on failure so the pipeline stops.

### Verifying after apply

```bash
npx prisma migrate status          # no pending migrations
npm run smoke                     # /health responds
curl -sf http://localhost:3001/health/ready | jq .
```

Then check the application, not just the database:

- [ ] `/health/ready` reports `ready`
- [ ] A login succeeds and the affected read path returns 200
- [ ] Error rate and p99 latency are flat over 15 minutes
- [ ] The new columns/tables are populated as expected on a real record
- [ ] No `prisma` errors in the application logs

### Rolling back

```bash
# Tier 1 — the schema is fine, the code is not
kubectl -n neurowealth rollout undo deployment/api
# or: docker run ... with the previous image tag

# Tier 2 — reverse the migration
# Applies rollback.sql, then stamps rolled_back_at in _prisma_migrations so
# 'prisma migrate deploy' will re-apply it later. Do not skip the history
# update: without it the next deploy is a no-op and the schema stays broken.
DATABASE_URL="$DATABASE_URL" \
HEALTHCHECK_URL=http://localhost:3001/health/ready \
  bash scripts/rollback-migration.sh <migration-name>

# Tier 3 — restore the snapshot, then reconcile
# See docs/RUNBOOK.md for the incident procedure.
```

If a migration failed part-way (rather than needing a rollback), see
[Appendix A: Common failure modes](#appendix-a-common-failure-modes).

After any rollback, redeploy the application version that matches the reverted
schema. A tier-2 rollback that leaves the newer application running will fail at
the first query against the dropped column — and the resulting 500s look like a
new incident rather than the tail of the old one.

---

## 7. PR checklist

The reviewer confirms these before approving. The PR template in
`.github/PULL_REQUEST_TEMPLATE.md` carries the downtime-impact block.

- [ ] Migration is classified, and the class is stated in the PR
- [ ] `rollback.sql` exists, is idempotent, and carries accurate loss warnings
- [ ] `rollback.sql` has been executed at least once (§5)
- [ ] Rolling-deploy safety: previous application version still works against the
      new schema
- [ ] Backup type matches the class (§2), and a snapshot identifier is in the PR
- [ ] Downtime impact block is filled in
- [ ] `npm test`, `npm run lint`, `npm run build` are green
- [ ] `Rollback rehearsal` and `Require rollback.sql per migration` CI jobs pass

---

## 8. Related documentation

- [Appendix A: Common failure modes](#appendix-a-common-failure-modes) — recipes for failed migrations
- [RUNBOOK.md](./RUNBOOK.md) — §6, the incident-time rollback procedure
- [DEPLOYMENT.md](./DEPLOYMENT.md) — environment matrix, k8s deploy, secrets
- [PRODUCTION_READINESS_CHECKLIST.md](./PRODUCTION_READINESS_CHECKLIST.md)
- [RUNBOOK.md — incident contacts](./RUNBOOK.md#7-incident-contacts)

---

## Appendix A. Common failure modes

Recipes distilled from real incidents. Each one ends with the same two
commands: mark the failed row in `_prisma_migrations` so Prisma will retry, then
`npx prisma migrate deploy`. A migration that fails midway leaves a row with
`finished_at IS NULL AND rolled_back_at IS NULL`, and `migrate deploy` refuses
to proceed (`P3009`) until that row is resolved.

```sql
-- Find the stuck row
SELECT migration_name, started_at, logs
FROM _prisma_migrations
WHERE finished_at IS NULL AND rolled_back_at IS NULL
ORDER BY started_at DESC;
```

### A.1 `CREATE INDEX CONCURRENTLY` inside a Prisma migration

**Incident:** `20260928180000_add_webhook_query_indexes`

**Symptom**

```
ERROR: CREATE INDEX CONCURRENTLY cannot run inside a transaction block
```

**Cause:** `prisma migrate deploy` runs each migration in a transaction.
PostgreSQL forbids `CONCURRENTLY` inside one. Any migration containing it fails
on first apply.

**Recipe: production (keep `CONCURRENTLY`, no table lock)**

```bash
# 1. Clear the failed row so Prisma will not block on it
npx prisma migrate resolve --rolled-back 20260928180000_add_webhook_query_indexes

# 2. Apply the indexes by hand, outside any transaction. IF NOT EXISTS makes
#    this safe to re-run after an interrupted build.
psql "$DATABASE_URL" <<'SQL'
CREATE INDEX CONCURRENTLY IF NOT EXISTS "user_webhook_deliveries_endpointId_createdAt_idx"
  ON "user_webhook_deliveries"("endpointId", "createdAt");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "webhook_deliveries_subscriptionId_status_createdAt_idx"
  ON "webhook_deliveries"("subscriptionId", "status", "createdAt");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "webhook_dead_letters_subscriptionId_status_firstFailedAt_idx"
  ON "webhook_dead_letters"("subscriptionId", "status", "firstFailedAt");
SQL

# 3. Record the migration as applied, then continue with the rest
npx prisma migrate resolve --applied 20260928180000_add_webhook_query_indexes
npx prisma migrate deploy
```

An interrupted `CONCURRENTLY` build leaves an `INVALID` index behind; `IF NOT
EXISTS` would then skip it. Check and drop before re-running:

```sql
SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
-- DROP INDEX CONCURRENTLY "<name>";
```

**Recipe: CI / throwaway databases:** remove `CONCURRENTLY` from the
migration file (blocking builds are fine where there is no traffic), then
`--rolled-back` and `migrate deploy`. Never do this to a migration that has
already been applied to a shared environment; add a new migration instead.

**Verify**

```sql
SELECT tablename, indexname FROM pg_indexes
WHERE tablename IN ('user_webhook_deliveries','webhook_deliveries','webhook_dead_letters')
  AND indexname LIKE '%_idx';
```

**Prevention:** do not put `CONCURRENTLY` in `migration.sql`. Ship the
blocking form in the migration and a documented manual step for production, or
classify the change per §2 and schedule the lock.

### A.2 Duplicate column on `ADD COLUMN`

**Incident:** `20260928172500_add_referral_fraud_detection`

**Symptom:** the migration fails with `column "reviewedBy" of relation
"referral_conversions" already exists` (likewise `reviewedAt`).

**Cause:** an earlier migration (`20260830163707_add_referral_fraud_review`)
already added those columns; the new migration added them again.

**Recipe**

```bash
# 1. Fix the SQL. Drop the duplicate columns, and make the genuinely new ones
#    idempotent:
#      ALTER TABLE "referral_conversions"
#        ADD COLUMN IF NOT EXISTS "fraudCheckScore" INTEGER;
#      ALTER TABLE "referral_conversions"
#        ADD COLUMN IF NOT EXISTS "fraudCheckFlags" TEXT[] DEFAULT ARRAY[]::TEXT[];
#    Keep rollback.sql in step with it.

# 2. Clear the failed row, then retry with the corrected file
npx prisma migrate resolve --rolled-back 20260928172500_add_referral_fraud_detection
npx prisma migrate deploy
```

Editing a migration file is only valid for one that has **not** succeeded
anywhere shared. If any environment recorded it as applied, leave it alone and
write a corrective migration.

**Verify**

```bash
psql "$DATABASE_URL" -c '\d referral_conversions'
```

**Prevention:** before adding a column, grep the migration history for it
(`grep -rn '"reviewedBy"' prisma/migrations`). Write `ADD COLUMN IF NOT EXISTS`
and `CREATE INDEX IF NOT EXISTS` by default.

### A.3 Failed rehearsal database

**Symptom:** `scripts/rehearse-migration-rollback.sh` fails on a migration,
you fix the SQL, and the next rehearsal still fails (or Prisma reports `P3009`)
because the rehearsal database remembers the earlier failed attempt.

**Recipe**

```bash
# Mark the failed migration rolled back so Prisma retries the fixed SQL
DATABASE_URL="$REHEARSAL_DATABASE_URL" \
  bash scripts/fix-failed-rehearsal.sh <migration-name>

# Re-run the rehearsal
DATABASE_URL="$REHEARSAL_DATABASE_URL" \
  bash scripts/rehearse-migration-rollback.sh
```

`fix-failed-rehearsal.sh` is just `prisma migrate resolve --rolled-back`
with argument checking. If the failed migration applied part of its changes
before erroring, the retry can trip over them; in that case discard the
rehearsal database instead:

```bash
psql -h <host> -U postgres -c 'DROP DATABASE IF EXISTS rehearsal_db;' \
                           -c 'CREATE DATABASE rehearsal_db;'
```

**Only ever point this at a rehearsal or throwaway database.** On a shared
environment, resolve the failure per §6 (rolling back) instead.

**Prevention:** run the rehearsal (§5) before pushing, and write idempotent SQL
(`IF [NOT] EXISTS`, `DO` blocks instead of `ADD CONSTRAINT IF NOT EXISTS` for
PostgreSQL < 12).

---

## 8. Database-Level Immutability and Append-Only Tables (#682)

For compliance and non-repudiation, tables such as `admin_audit_logs` must be strictly append-only at the database layer rather than relying solely on application-level conventions.

### Enforcement Strategy

1. **Row-Level Trigger Enforcement:**
   A `BEFORE UPDATE OR DELETE` trigger (`trg_admin_audit_logs_append_only`) intercepts all mutating operations:
   - `UPDATE`: Unconditionally raises exception (`SQLSTATE 55000: AdminAuditLog is append-only: UPDATE operations are strictly prohibited`).
   - `DELETE`: Direct application deletes are denied by privilege grants and the trigger. Retention batches call the restricted `purge_admin_audit_logs(ids, cutoff)` security-definer function, which enforces the 500-row cap and database-configured retention age.
   - **Retention Window:** The `admin_audit_retention_control.retentionDays` value is the database enforcement floor (default 365). Configure it to match `RETENTION_ADMIN_AUDIT_LOGS_DAYS`; the purge function rejects cutoffs newer than this policy.
     ```sql
     UPDATE public.admin_audit_retention_control
     SET "retentionDays" = 365, "updatedAt" = CURRENT_TIMESTAMP
     WHERE id = TRUE;
     ```
   - **Legal Hold Override:** A database-controlled singleton row in `admin_audit_retention_control` blocks the privileged purge function and trigger. A transaction-local `neuro.legal_hold='true'` also blocks the operation. Operators activate a persistent hold with `UPDATE public.admin_audit_retention_control SET "legalHold" = TRUE, "updatedAt" = CURRENT_TIMESTAMP WHERE id = TRUE;` using the database owner role.
   - **Restricted Purge:** The application role has no direct `UPDATE` or `DELETE` privilege. Retention uses `public.purge_admin_audit_logs(ids, cutoff)`, a security-definer function limited to at most 500 expired rows. Grant `EXECUTE` on that function to the runtime role if it is not named `neuro_app`; do not grant the role direct delete access.

2. **Role-Based Privilege Hardening:**
   In environments with distinct database roles, revoke direct mutation privileges from the application role:
   ```sql
   -- Production role hardening (run the app as a non-owner role)
   REVOKE UPDATE, DELETE ON "admin_audit_logs" FROM neuro_app;
   GRANT SELECT, INSERT ON "admin_audit_logs" TO neuro_app;
   GRANT SELECT ON "admin_audit_retention_control" TO neuro_app;
   GRANT EXECUTE ON FUNCTION public.purge_admin_audit_logs(TEXT[], TIMESTAMPTZ) TO neuro_app;
   ```
   *Note:* Run the application with a non-owner database role. Table owners and superusers are trusted administrators and can bypass ordinary grants; they must not be used as runtime credentials. For a differently named runtime role, revoke direct `UPDATE`/`DELETE` and grant `SELECT`/`INSERT` on the audit table, `SELECT` on the retention control table, and `EXECUTE` on the purge function.

### Downtime Impact Assessment: `20261021140000_admin_audit_log_append_only`

```markdown
### Downtime impact
- **Class:** A
- **Locks taken:** ROW EXCLUSIVE (trigger and index creation)
- **Expected lock duration:** <15ms
- **Writes blocked during migration:** no
- **Requires traffic drain:** no
- **Rollback tier:** rollback.sql
```
