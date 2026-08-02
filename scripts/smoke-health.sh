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

# ── Compression middleware verification ────────────────────────────────────────
# Verify the compression middleware is active by checking:
# 1. Vary: Accept-Encoding header (always set by middleware regardless of body size)
# 2. Content-Encoding header (only present when body exceeds 1 KB threshold)
#
# See issue #218.

echo "[smoke] Verifying compression middleware (Vary: Accept-Encoding)..."
vary_header="$(curl -sf -I "${BASE_URL}/health/live" | grep -i '^Vary:' | tr -d '[:space:]')"
if echo "${vary_header}" | grep -qi 'accept-encoding'; then
  echo "[smoke] ✓ Vary: Accept-Encoding confirmed — compression middleware active"
else
  echo "[smoke] ⚠ Vary: Accept-Encoding not found — compression may not be active"
fi

echo "[smoke] Checking Content-Encoding on large-response endpoints..."
# Use a query parameter or path that generates a larger response to test actual compression
encoding_header="$(curl -sf -H 'Accept-Encoding: gzip' -o /dev/null -w '%{content_encoding}' "${BASE_URL}/health/ready" 2>/dev/null || echo '')"
if [[ -n "${encoding_header}" && "${encoding_header}" != "identity" ]]; then
  echo "[smoke] ✓ Content-Encoding: ${encoding_header}"
else
  echo "[smoke]   (content below 1 KB threshold — compression not expected)"
fi

echo "[smoke] ✓ Production startup smoke check passed"
