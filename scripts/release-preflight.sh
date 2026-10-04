#!/usr/bin/env bash
# Run against a clean checkout and a disposable/staging database with migrations applied.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}/.."

workspace_status="$(git status --porcelain --untracked-files=normal)"
if [[ -n "$workspace_status" ]]; then
  echo 'Release preflight requires a clean Git workspace (including untracked files).' >&2
  exit 1
fi

run_check() {
  echo "[release preflight] $1"
  shift
  "$@"
}

run_check '1/8 Environment parity' npm run env:parity
run_check '2/8 Formatting' npm run format:check
run_check '3/8 Lint' npm run lint
run_check '4/8 Type safety' npm run typecheck
run_check '5/8 OpenAPI lint (not runtime contract validation)' npm run validate:spec
run_check '6/8 Migration status' npx --no-install prisma migrate status
run_check 'Rollback file coverage' bash scripts/check-migration-rollback.sh
run_check '7/8 Default Jest suite (configured exclusions apply)' npm test -- --runInBand --watchman=false
run_check '8/8 Production build' npm run build

echo 'Release preflight passed. Complete tier-specific sign-off and rollback rehearsal before deployment.'
