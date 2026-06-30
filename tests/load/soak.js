/**
 * Soak test — 20 VUs × 1 hour.
 *
 * Purpose: detect memory leaks, connection pool exhaustion, and gradual
 * latency degradation under moderate long-duration load.  Compare p95
 * latency at t=5min vs t=55min: a growing gap indicates a leak.
 * Run:     k6 run tests/load/soak.js -e BASE_URL=http://localhost:3000
 *
 * Note: this test takes 1 hour.  Run against staging only.
 *       Add --out json=results/soak-$(date +%Y%m%d).json to persist results.
 */
import http from 'k6/http'
import { check, sleep } from 'k6'
import { Rate, Trend, Counter } from 'k6/metrics'

const errorRate = new Rate('errors')
const portfolioLatency = new Trend('portfolio_latency', true)
const memoryLeakIndicator = new Counter('sustained_slow_responses')

export const options = {
  stages: [
    { duration: '2m', target: 20 },   // ramp up
    { duration: '56m', target: 20 },  // sustained soak
    { duration: '2m', target: 0 },    // ramp down
  ],

  thresholds: {
    // After 1 hour of moderate load, SLOs must still hold.
    http_req_failed: ['rate<0.01'],
    errors: ['rate<0.01'],
    portfolio_latency: ['p(95)<500', 'p(99)<750'],
    http_req_duration: ['p(95)<500'],
    // If more than 5 % of requests exceed 1 s across the whole run, flag it.
    sustained_slow_responses: ['count<50'],
  },
}

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000'

export default function () {
  // ── Read path ─────────────────────────────────────────────────────────────
  const portfolio = http.get(`${BASE_URL}/api/portfolio`, {
    headers: { Authorization: `Bearer ${__ENV.TEST_JWT || 'soak-token'}` },
  })
  portfolioLatency.add(portfolio.timings.duration)
  errorRate.add(portfolio.status >= 500)
  check(portfolio, { 'portfolio not 5xx': (r) => r.status < 500 })

  // Track responses that exceed 1 s as a memory-leak signal.
  if (portfolio.timings.duration > 1000) {
    memoryLeakIndicator.add(1)
  }
  sleep(1)

  // ── Transactions ──────────────────────────────────────────────────────────
  const tx = http.get(`${BASE_URL}/api/transactions`, {
    headers: { Authorization: `Bearer ${__ENV.TEST_JWT || 'soak-token'}` },
  })
  errorRate.add(tx.status >= 500)
  check(tx, { 'transactions not 5xx': (r) => r.status < 500 })
  sleep(1)

  // ── Health check — should always respond quickly ──────────────────────────
  const health = http.get(`${BASE_URL}/health`)
  check(health, { 'health 200': (r) => r.status === 200 })
  errorRate.add(health.status !== 200)
  sleep(1)
}
