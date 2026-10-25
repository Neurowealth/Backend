#!/usr/bin/env bash
# Verify the existing health API. No deployment or traffic-routing mutations.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_URL="${1:-${TARGET_URL:-http://localhost:3000}}"
TARGET_URL="${TARGET_URL%/}"
: "${INTERNAL_SERVICE_TOKEN:?Set INTERNAL_SERVICE_TOKEN for the authenticated /health/deep probe}"

# Keep the credential out of curl's command-line arguments and reject header injection.
if [[ "$INTERNAL_SERVICE_TOKEN" == *$'\n'* || "$INTERNAL_SERVICE_TOKEN" == *$'\r'* ]]; then
  echo 'Invalid internal service token.' >&2
  exit 1
fi
case "$TARGET_URL" in
  http://*|https://*) ;;
  *) echo 'Target URL must use http or https.' >&2; exit 1 ;;
esac
umask 077
PROBE_DIR="$(mktemp -d)"
trap 'rm -rf "$PROBE_DIR"' EXIT
printf 'X-Internal-Token: %s\n' "$INTERNAL_SERVICE_TOKEN" > "$PROBE_DIR/headers"

check_endpoint() {
  local path="$1" kind="$2" http_code
  local -a auth_args=(--header "Accept: application/json")
  if [[ "$kind" == deep ]]; then
    auth_args=(--header "@$PROBE_DIR/headers")
  fi
  # Do not follow redirects: credentials must only reach the configured target.
  if ! http_code=$(curl --silent --show-error --connect-timeout 3 --max-time 10 \
    --output "$PROBE_DIR/body" --write-out '%{http_code}' \
    "${auth_args[@]}" "${TARGET_URL}${path}"); then
    echo "FAIL $path: transport error" >&2
    return 1
  fi
  if [[ "$http_code" != 200 ]]; then
    echo "FAIL $path: HTTP $http_code (expected 200)" >&2
    return 1
  fi
  if ! node "$SCRIPT_DIR/release-health-check.cjs" "$kind" "$PROBE_DIR/body"; then
    echo "FAIL $path: invalid or unhealthy response" >&2
    return 1
  fi
  echo "PASS $path"
}

FAILED=0
check_endpoint /health live || FAILED=1
check_endpoint /health/ready ready || FAILED=1
check_endpoint /health/deep deep || FAILED=1
if [[ "$FAILED" != 0 ]]; then
  echo 'Release verification failed. Do not promote traffic.' >&2
  exit 1
fi
echo 'Release health verification passed. Complete the manual Redis/outbox checks before promotion.'
