#!/usr/bin/env bash
# check-migration-rollback.sh — Enforce that every Prisma migration ships a rollback.
#
# Prisma migrations are forward-only. To keep a recovery path, every migration
# directory that contains a migration.sql MUST also contain a rollback.sql
# (see scripts/rollback-migration.sh and docs/RUNBOOK.md). This check fails CI
# if any migration is missing its rollback so the gap is caught at review time.
#
# Usage: bash scripts/check-migration-rollback.sh

set -euo pipefail

MIGRATIONS_DIR="prisma/migrations"
MISSING=()

if [[ ! -d "$MIGRATIONS_DIR" ]]; then
  echo "No migrations directory found at ${MIGRATIONS_DIR} — nothing to check."
  exit 0
fi

for dir in "$MIGRATIONS_DIR"/*/; do
  [[ -f "${dir}migration.sql" ]] || continue
  if [[ ! -f "${dir}rollback.sql" ]]; then
    MISSING+=("${dir}rollback.sql")
  fi
done

if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo "::error::Migration(s) missing a rollback.sql file:"
  for f in "${MISSING[@]}"; do
    echo "  - ${f}"
  done
  echo ""
  echo "Every migration must include a hand-written rollback.sql that reverses"
  echo "its migration.sql. Document any irreversible steps inside the file."
  exit 1
fi

echo "✓ All migrations have a rollback.sql."
