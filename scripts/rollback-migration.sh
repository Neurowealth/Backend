#!/usr/bin/env bash
# rollback-migration.sh — Reverse a single Prisma migration using its rollback.sql.
#
# Prisma migrations are forward-only; there is no built-in "down". This script
# applies the hand-written rollback.sql that ships next to each migration's
# migration.sql, then marks the migration as rolled back in Prisma's history so
# `prisma migrate deploy` can re-apply it later.
#
# The history update must not be skipped: without it the schema is reverted but
# the history still reports the migration as applied, so the next deploy is a
# no-op and the mismatch goes unnoticed.
#
# Usage:
#   DATABASE_URL=postgresql://... bash scripts/rollback-migration.sh <migration-name>
#
# Example:
#   DATABASE_URL=$DATABASE_URL bash scripts/rollback-migration.sh 20260627_add_transaction_events
#
# Options (env):
#   CI=1                 Skip the interactive confirmation prompt.
#   HEALTHCHECK_URL=...   If set, curl this URL after rollback (expects HTTP 200).
#
# Exit codes: 0 on success, non-zero on any failure.

set -euo pipefail

MIGRATION="${1:-}"
MIGRATIONS_DIR="prisma/migrations"

if [[ -z "$MIGRATION" ]]; then
  echo "ERROR: missing migration name." >&2
  echo "Usage: DATABASE_URL=... bash scripts/rollback-migration.sh <migration-name>" >&2
  echo "Available migrations:" >&2
  ls -1 "$MIGRATIONS_DIR" | grep -v migration_lock.toml >&2 || true
  exit 1
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: DATABASE_URL is not set." >&2
  exit 1
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "ERROR: psql is required but not found on PATH." >&2
  exit 1
fi

ROLLBACK_FILE="${MIGRATIONS_DIR}/${MIGRATION}/rollback.sql"

if [[ ! -f "$ROLLBACK_FILE" ]]; then
  echo "ERROR: no rollback file found at ${ROLLBACK_FILE}" >&2
  echo "       Every migration must ship a rollback.sql (enforced in CI)." >&2
  exit 1
fi

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║              NeuroWealth — Migration Rollback                  ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "  Migration : ${MIGRATION}"
echo "  Rollback  : ${ROLLBACK_FILE}"
_db_safe="${DATABASE_URL##*@}"; echo "  Database  : ${_db_safe%%\?*}"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "WARNING: rollbacks can be destructive. Confirm a recent backup exists."
echo ""

if [[ -z "${CI:-}" ]]; then
  read -r -p "Type the migration name to confirm rollback: " CONFIRM
  if [[ "$CONFIRM" != "$MIGRATION" ]]; then
    echo "Confirmation did not match — aborting." >&2
    exit 1
  fi
fi

echo "[rollback] → Applying ${ROLLBACK_FILE} (single transaction)..."
# ON_ERROR_STOP + a single -f invocation runs the file atomically; psql wraps
# the whole file in one transaction when --single-transaction is passed.
psql "$DATABASE_URL" --single-transaction --set ON_ERROR_STOP=1 -f "$ROLLBACK_FILE"
echo "[rollback] ✓ Rollback SQL applied"

echo "[rollback] → Marking migration as rolled back in _prisma_migrations..."
# Prisma 5 has no first-class "down". `prisma migrate resolve --rolled-back`
# looks like the answer but is not: it only accepts a migration in a *failed*
# state and exits P3012 for one that was applied successfully, which is the
# normal case here. Setting rolled_back_at directly is the same state that
# command would produce, and `migrate deploy` then re-applies the migration.
#
# If this step is skipped the database is left in the worst possible state: the
# columns are gone but the history still claims the migration is applied, so
# `migrate deploy` is a no-op and the schema stays broken silently.
#
# Returns: how many rows were newly marked, and whether the migration is
# already recorded as rolled back (so a re-run after a partial failure is safe).
MARK_RESULT="$(psql "$DATABASE_URL" -tA --set ON_ERROR_STOP=1 \
  --set=migration_name="$MIGRATION" <<'SQL' | tr -d '[:space:]'
-- Returned as a result row rather than relying on the "UPDATE n" command tag,
-- which psql prints differently depending on version and flags.
WITH marked AS (
  UPDATE "_prisma_migrations"
     SET rolled_back_at = now()
   WHERE migration_name = :'migration_name'
     AND finished_at IS NOT NULL
     AND rolled_back_at IS NULL
  RETURNING 1
)
SELECT COUNT(*) FROM marked;
SQL
)"

ALREADY_ROLLED_BACK="$(psql "$DATABASE_URL" -tA --set ON_ERROR_STOP=1 \
  --set=migration_name="$MIGRATION" <<'SQL' | tr -d '[:space:]'
SELECT COUNT(*) FROM "_prisma_migrations"
 WHERE migration_name = :'migration_name'
   AND finished_at IS NOT NULL
   AND rolled_back_at IS NOT NULL;
SQL
)"

if [[ "$MARK_RESULT" == "1" ]]; then
  echo "[rollback] ✓ Migration history updated"
elif [[ "${ALREADY_ROLLED_BACK:-0}" -gt 0 ]]; then
  # rollback.sql is written to be idempotent, so re-running after an interrupted
  # rollback is safe and should not be an error.
  echo "[rollback] ✓ Already recorded as rolled back (nothing to do)"
else
  echo "[rollback] ✗ No applied history row found for '${MIGRATION}'." >&2
  echo "           The rollback SQL has run but the history was not updated," >&2
  echo "           so 'migrate deploy' will NOT re-apply this migration." >&2
  echo "           Verify manually with:" >&2
  echo "             SELECT * FROM _prisma_migrations WHERE migration_name = '${MIGRATION}';" >&2
  exit 1
fi

echo "[rollback] → Running post-rollback health check..."
psql "$DATABASE_URL" --set ON_ERROR_STOP=1 -c "SELECT 1;" >/dev/null
echo "[rollback] ✓ Database reachable"

if [[ -n "${HEALTHCHECK_URL:-}" ]]; then
  STATUS=$(curl -sf -o /dev/null -w "%{http_code}" "$HEALTHCHECK_URL" || true)
  if [[ "$STATUS" != "200" ]]; then
    echo "[rollback] ✗ Health check ${HEALTHCHECK_URL} returned ${STATUS} (expected 200)" >&2
    exit 1
  fi
  echo "[rollback] ✓ Application health check passed (${HEALTHCHECK_URL})"
fi

echo ""
echo "[rollback] ✓ Rollback of ${MIGRATION} complete."
echo "  Next steps:"
echo "    • Verify application behaviour against the reverted schema"
echo "    • Re-deploy the previous application version if needed"
echo "    • Once a fixed migration is ready, 'prisma migrate deploy' re-applies it"
echo ""
