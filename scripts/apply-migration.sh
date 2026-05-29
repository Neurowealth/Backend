#!/usr/bin/env bash
# apply-migration.sh — Safe migration runner for CI/CD and manual deployments.
#
# Usage:
#   DATABASE_URL=postgresql://... bash scripts/apply-migration.sh
#
# What it does:
#   1. Prints a pre-flight checklist as a reminder of manual steps.
#   2. Applies pending Prisma migrations (migrate deploy — non-destructive).
#   3. Runs the smoke test to verify schema and connectivity.
#   4. Exits 1 on any failure so CI/CD pipelines detect the breakage.
#
# References: Issue #99 — Secrets management and production deployment checklist

set -euo pipefail

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║          NeuroWealth — Safe Migration Checklist              ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  Before proceeding, confirm the following (Ctrl-C to abort): ║"
echo "║                                                               ║"
echo "║  [ ] DATABASE_URL points to the correct environment          ║"
echo "║  [ ] A database backup/snapshot was taken in the last 1 hr   ║"
echo "║  [ ] The migration has been reviewed and is non-destructive   ║"
echo "║  [ ] Deployment is scheduled during a low-traffic window      ║"
echo "║  [ ] Rollback plan is documented and ready                    ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

if [[ -z "${CI:-}" ]]; then
  # Interactive: give operator 5 s to abort
  echo "Proceeding in 5 seconds... (Ctrl-C to abort)"
  sleep 5
fi

echo "[migration] → Applying Prisma migrations..."
npx prisma migrate deploy
echo "[migration] ✓ Migrations applied successfully"

echo "[migration] → Running smoke test..."
npm run smoke
echo "[migration] ✓ Smoke test passed"

echo ""
echo "[migration] ✓ Deployment migration complete."
echo "  Next steps:"
echo "    • Monitor application logs for errors (winston / CloudWatch / Datadog)"
echo "    • Verify /health and /api readiness endpoints respond 200"
echo "    • If errors appear, execute rollback plan immediately"
echo ""
