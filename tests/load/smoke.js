/**
 * Smoke test — 5 VUs × 1 minute.
 *
 * Purpose: verify basic functionality is intact before any sustained load run.
 * Run:     k6 run tests/load/smoke.js -e BASE_URL=http://localhost:3000
 */
import http from 'k6/http'
import { check, sleep } from 'k6'
import { Rate, Trend } from 'k6/metrics'

const errorRate = new Rate('errors')
const portfolioLatency = new Trend('portfolio_latency', true)
const depositLatency = new Trend('deposit_latency', true)

export const options = {
  vus: 5,
  duration: '1m',

  thresholds: {
    // SLO gates — smoke must pass these before load/stress runs
    http_req_failed: ['rate<0.01'],        // < 1 % error rate
    errors: ['rate<0.01'],
    http_req_duration: ['p(95)<500'],      // p95 < 500 ms across all requests
    portfolio_latency: ['p(95)<500'],      // /api/portfolio p95 < 500 ms
    deposit_latency: ['p(99)<2000'],       // /api/deposit   p99 < 2 s
  },
}

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000'

export default function () {
  // ── Health ────────────────────────────────────────────────────────────────
  const health = http.get(`${BASE_URL}/health`)
  check(health, { 'health 200': (r) => r.status === 200 })
  errorRate.add(health.status !== 200)
  sleep(0.2)

  // ── Portfolio ─────────────────────────────────────────────────────────────
  const portfolio = http.get(`${BASE_URL}/api/portfolio`, {
    headers: { Authorization: `Bearer ${__ENV.TEST_JWT || 'smoke-token'}` },
  })
  portfolioLatency.add(portfolio.timings.duration)
  check(portfolio, {
    'portfolio 200 or 401': (r) => r.status === 200 || r.status === 401,
  })
  errorRate.add(portfolio.status >= 500)
  sleep(0.3)

  // ── Auth challenge (public) ────────────────────────────────────────────────
  const challenge = http.post(
    `${BASE_URL}/api/auth/challenge`,
    JSON.stringify({ walletAddress: 'GBSMOKE0000000000000000000000000000000000000000000000' }),
    { headers: { 'Content-Type': 'application/json' } },
  )
  check(challenge, {
    'challenge 200 or 400': (r) => r.status === 200 || r.status === 400,
  })
  errorRate.add(challenge.status >= 500)
  sleep(0.5)

  // ── Deposit probe ─────────────────────────────────────────────────────────
  const deposit = http.post(
    `${BASE_URL}/api/deposit`,
    JSON.stringify({ amount: '1', token: 'USDC' }),
    { headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${__ENV.TEST_JWT || 'smoke-token'}`,
      },
    },
  )
  depositLatency.add(deposit.timings.duration)
  check(deposit, {
    'deposit 200 or 401 or 422': (r) => [200, 401, 422].includes(r.status),
  })
  errorRate.add(deposit.status >= 500)
  sleep(0.5)
}
