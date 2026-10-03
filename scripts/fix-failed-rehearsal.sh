#!/usr/bin/env bash
# fix-failed-rehearsal.sh - Fix a failed migration in the rehearsal database
#
# When a migration fails in rehearsal, mark it as rolled back so it can be retried
# with the fixed SQL.

set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: DATABASE_URL is not set."
  exit 1
fi

MIGRATION_NAME="${1:-}"

if [[ -z "$MIGRATION_NAME" ]]; then
  echo "Usage: DATABASE_URL=... bash scripts/fix-failed-rehearsal.sh <migration-name>"
  echo ""
  echo "Example:"
  echo "  DATABASE_URL=... bash scripts/fix-failed-rehearsal.sh 20260928200000_add_totp_credentials"
  exit 1
fi

echo "Marking migration '${MIGRATION_NAME}' as rolled back..."
npx prisma migrate resolve --rolled-back "${MIGRATION_NAME}"

echo ""
echo "✓ Migration marked as rolled back. You can now run the rehearsal script again."
echo ""
echo "Run: bash scripts/rehearse-migration-rollback.sh"
