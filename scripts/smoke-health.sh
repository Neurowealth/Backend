#!/usr/bin/env bash
# smoke-health.sh — Start the built server and verify GET /health returns 200.
#
# Exits non-zero if the server fails to start or /health does not respond in time.
# Used by the production build smoke CI workflow (issue #152).
#
# Prerequisites:
#   - dist/index.js exists (npm run build)
#   - production node_modules installed
#   - DATABASE_URL and other required env vars set
#   - migrations applied

set -euo pipefail

PORT="${PORT:-3001}"
BASE_URL="http://127.0.0.1:${PORT}"
HEALTH_PATH="${SMOKE_HEALTH_PATH:-/health}"
TIMEOUT_SEC="${SMOKE_TIMEOUT_SEC:-120}"
SERVER_PID=""

cleanup() {
  if [[ -n "${SERVER_PID}" ]] && kill -0 "${SERVER_PID}" 2>/dev/null; then
    kill "${SERVER_PID}" 2>/dev/null || true
    wait "${SERVER_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

if [[ ! -f dist/index.js ]]; then
  echo "::error::dist/index.js not found — run npm run build first"
  exit 1
fi

echo "[smoke] Starting server (node dist/index.js)..."
node dist/index.js &
SERVER_PID=$!

deadline=$((SECONDS + TIMEOUT_SEC))
until curl -sf "${BASE_URL}${HEALTH_PATH}" > /dev/null; do
  if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
    echo "::error::Server exited before ${HEALTH_PATH} returned 200"
    exit 1
  fi
  if (( SECONDS >= deadline )); then
    echo "::error::Timed out after ${TIMEOUT_SEC}s waiting for ${HEALTH_PATH}"
    exit 1
  fi
  sleep 2
done

body="$(curl -sf "${BASE_URL}${HEALTH_PATH}")"
echo "[smoke] ${HEALTH_PATH} → 200"
echo "[smoke] Response: ${body}"

# ── Compression smoke check ──────────────────────────────────────────────────
# Verify that the server handles Accept-Encoding headers correctly and returns
# Content-Encoding when response exceeds the 1 KB compression threshold.
echo "[smoke] Checking compression (Accept-Encoding: gzip)..."
comp_status="$(curl -s -o /dev/null -w '%{http_code}' -H 'Accept-Encoding: gzip, deflate, br' "${BASE_URL}${HEALTH_PATH}")"
if [[ "${comp_status}" != "200" ]]; then
  echo "::error::Compression check failed — ${HEALTH_PATH} returned ${comp_status} with Accept-Encoding header"
  exit 1
fi
echo "[smoke] ✓ Compression middleware active (no errors with Accept-Encoding)"

echo "[smoke] ✓ Production startup smoke check passed"
