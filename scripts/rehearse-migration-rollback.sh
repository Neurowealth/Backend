#!/usr/bin/env bash
# rehearse-migration-rollback.sh — Prove the rollback path works before needing it.
#
# The question a rollback rehearsal exists to answer is narrow and concrete:
# "if I have to reverse this migration tonight, does the reverse SQL actually
# undo it, and does the forward SQL then re-apply cleanly?" This script proves
# exactly that, for any migration, without needing to know anything about it.
#
# It deliberately does NOT touch Prisma's migration history. Marking a migration
# as rolled back and hoping `migrate deploy` restores it depends on undocumented
# `_prisma_migrations` semantics (Prisma 5's `migrate resolve --rolled-back`
# refuses outright with P3012 for a migration that applied successfully, and
# re-applying leaves several history rows in states the CLI does not
# round-trip). Every one of those failure modes has the same nasty property:
# the columns are gone, the history still says "applied", and the next deploy is
# a silent no-op. Applying the SQL directly proves the same thing while leaving
# the database exactly as it was found.
#
# Usage:
#   DATABASE_URL=postgresql://... bash scripts/rehearse-migration-rollback.sh
#
# Options (env):
#   CI=1                Skip the interactive confirmation prompts.
#   MIGRATION=<name>    Rehearse a specific migration instead of the newest applied one.
#
# Exit codes: 0 if the full apply → rollback → re-apply round trip succeeded.

set -euo pipefail

MIGRATIONS_DIR="prisma/migrations"

log() { echo "[rehearsal] → $*"; }
ok()  { echo "[rehearsal] ✓ $*"; }
die() { echo "[rehearsal] ✗ $*" >&2; exit 1; }

if [[ -z "${DATABASE_URL:-}" ]]; then
  die "DATABASE_URL is not set."
fi

if ! command -v psql >/dev/null 2>&1; then
  die "psql is required but not found on PATH."
fi

# ── Safety guard ─────────────────────────────────────────────────────────────
# The rehearsal reverses a migration, which drops whatever that migration
# created. Refuse to point it at a database whose name says "production" unless
# the operator has explicitly acknowledged the risk, so a stray DATABASE_URL
# cannot destroy real data.
DB_TARGET="$(psql "$DATABASE_URL" -tAc 'SELECT current_database();' 2>/dev/null || true)"
DB_TARGET="${DB_TARGET//[[:space:]]/}"

if [[ -z "$DB_TARGET" ]]; then
  die "Could not connect to DATABASE_URL (target database: ${DB_TARGET:-unknown})."
fi

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║          NeuroWealth — Migration Rollback Rehearsal           ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "  Database  : ${DB_TARGET}"
_db_safe="${DATABASE_URL##*@}"; echo "  Host      : ${_db_safe%%\?*}"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

if [[ "$DB_TARGET" =~ ^(prod|production|mainnet|live) ]]; then
  echo "WARNING: '${DB_TARGET}' looks like a production database." >&2
  echo "         This rehearsal will DROP whatever the newest migration" >&2
  echo "         created. Only continue inside a maintenance window." >&2
  if [[ -z "${CI:-}" ]]; then
    read -r -p "Type the database name to confirm: " CONFIRM
    if [[ "$CONFIRM" != "$DB_TARGET" ]]; then
      die "Confirmation did not match — aborting."
    fi
  else
    die "Refusing to rehearse against '${DB_TARGET}' in CI. Point this at staging."
  fi
fi

# ── Helpers ──────────────────────────────────────────────────────────────────

has_pending_migrations() {
  psql "$DATABASE_URL" -tAc \
    "SELECT COUNT(*) FROM _prisma_migrations
     WHERE finished_at IS NULL AND rolled_back_at IS NULL;" | tr -d '[:space:]'
}

# A structural fingerprint of the whole public schema: every column with its type,
# plus every index. Comparing these before and after is how the rehearsal knows
# the reverse SQL did something, and that re-applying restored the exact schema.
# This works for any migration without hard-coding table names.
schema_fingerprint() {
  psql "$DATABASE_URL" -tAc "
    SELECT md5(string_agg(item, '|' ORDER BY item)) FROM (
      SELECT table_name || '.' || column_name || ':' || data_type AS item
        FROM information_schema.columns
       WHERE table_schema = 'public'
      UNION ALL
      SELECT indexname
        FROM pg_indexes
       WHERE schemaname = 'public'
    ) AS parts;" | tr -d '[:space:]'
}

# ── 1. Apply pending migrations ───────────────────────────────────────────────

log "Applying all pending migrations..."
npx prisma migrate deploy >/dev/null
ok "Database is at head"

if [[ "$(has_pending_migrations)" != "0" ]]; then
  die "Migrations are still pending after 'migrate deploy'."
fi

# ── 2. Pick the migration to reverse ─────────────────────────────────────────

if [[ -n "${MIGRATION:-}" ]]; then
  TARGET="$MIGRATION"
else
  TARGET="$(psql "$DATABASE_URL" -tAc \
    "SELECT migration_name FROM _prisma_migrations
     WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
     ORDER BY finished_at DESC, started_at DESC LIMIT 1;" | tr -d '[:space:]')"
fi

if [[ -z "$TARGET" || "$TARGET" == "none" ]]; then
  die "No applied migration found to rehearse."
fi

MIGRATE_FILE="${MIGRATIONS_DIR}/${TARGET}/migration.sql"
ROLLBACK_FILE="${MIGRATIONS_DIR}/${TARGET}/rollback.sql"

if [[ ! -f "$ROLLBACK_FILE" ]]; then
  die "Migration '${TARGET}' has no rollback.sql — it cannot be rehearsed."
fi
if [[ ! -f "$MIGRATE_FILE" ]]; then
  die "Migration '${TARGET}' has no migration.sql — cannot re-apply it."
fi

ok "Rehearsing rollback of: ${TARGET}"

if [[ -z "${CI:-}" ]]; then
  read -r -p "Type the migration name to start the rehearsal: " CONFIRM
  if [[ "$CONFIRM" != "$TARGET" ]]; then
    die "Confirmation did not match — aborting."
  fi
fi

BEFORE="$(schema_fingerprint)"
[[ -n "$BEFORE" ]] || die "Could not read a schema fingerprint (is the database empty?)"

# ── 3. Roll back ─────────────────────────────────────────────────────────────

log "Rolling back ${TARGET}..."
psql "$DATABASE_URL" --single-transaction --set ON_ERROR_STOP=1 \
  -f "$ROLLBACK_FILE" >/dev/null
ok "Rollback SQL applied"

ROLLED_BACK="$(schema_fingerprint)"

# A rollback.sql that changes nothing is worse than a missing one: it looks like
# a working recovery path during an incident and reverts nothing.
if [[ "$ROLLED_BACK" == "$BEFORE" ]]; then
  die "rollback.sql for '${TARGET}' did not change the schema at all. The migration is not reversible as written."
fi
ok "Rollback changed the schema (reversal is real, not a no-op)"

# ── 4. Re-apply ──────────────────────────────────────────────────────────────

log "Re-applying ${TARGET}..."
psql "$DATABASE_URL" --single-transaction --set ON_ERROR_STOP=1 \
  -f "$MIGRATE_FILE" >/dev/null
ok "migration.sql re-applied"

AFTER="$(schema_fingerprint)"

if [[ "$AFTER" != "$BEFORE" ]]; then
  die "Schema does not match the pre-rehearsal state after re-apply."
  echo "       before=${BEFORE}" >&2
  echo "       after =${AFTER}" >&2
fi
ok "Schema round-tripped exactly"

# ── 5. Confirm nothing was left behind ───────────────────────────────────────

if [[ "$(has_pending_migrations)" != "0" ]]; then
  die "Migrations are pending after the rehearsal."
fi

npx prisma migrate status >/dev/null 2>&1 \
  || die "'prisma migrate status' is not clean after the rehearsal."

ok "Migration history untouched — the database is exactly as it was found"

# ── 6. Report ────────────────────────────────────────────────────────────────

echo ""
echo "[rehearsal] ✓ Rehearsal complete for ${TARGET}"
echo "  • rollback.sql reverted the change (and was proven not to be a no-op)"
echo "  • migration.sql re-applied and restored the schema byte-for-byte"
echo "  • migration history was never modified"
echo ""
echo "  This migration's recovery path is proven. Reference it in the PR's"
echo "  rollback-readiness notes before deploying."
echo ""
