/**
 * Stress test — ramp to 200 VUs to find the breaking point.
 *
 * Purpose: determine at what concurrency level error rates spike, latency
 * degrades beyond SLO, or the service returns 5xx responses.  Not expected
 * to pass all SLO thresholds — the goal is to observe failure modes and
 * record the breaking point in docs/SLO_GUIDANCE.md.
 * Run:     k6 run tests/load/stress.js -e BASE_URL=http://localhost:3000
 */
import http from 'k6/http'
import { check, sleep } from 'k6'
import { Rate, Trend, Counter } from 'k6/metrics'

const errorRate = new Rate('errors')
const portfolioLatency = new Trend('portfolio_latency', true)
const breakingPointVUs = new Counter('breaking_point_vus')

export const options = {
  stages: [
    { duration: '2m', target: 50 },   // warm up
    { duration: '2m', target: 100 },  // step 1
    { duration: '2m', target: 150 },  // step 2
    { duration: '2m', target: 200 },  // breaking-point target
    { duration: '2m', target: 100 },  // step back to observe recovery
    { duration: '1m', target: 0 },    // ramp down
  ],

  thresholds: {
    // These are observability thresholds, not hard pass/fail gates.
    // Stress is *expected* to breach SLO — watch the console output.
    http_req_failed: ['rate<0.20'],   // alert if more than 20 % of requests fail
    errors: ['rate<0.20'],
    portfolio_latency: ['p(99)<5000'], // tolerate up to 5 s at peak
  },
}

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000'

export default function () {
  const portfolio = http.get(`${BASE_URL}/api/portfolio`, {
    headers: { Authorization: `Bearer ${__ENV.TEST_JWT || 'stress-token'}` },
    timeout: '10s',
  })
  portfolioLatency.add(portfolio.timings.duration)

  const failed = portfolio.status >= 500
  errorRate.add(failed)
  if (failed) breakingPointVUs.add(1)

  check(portfolio, {
    'portfolio responded': (r) => r.status !== 0,
    'portfolio not 503': (r) => r.status !== 503,
  })

  sleep(0.3)

  const deposit = http.post(
    `${BASE_URL}/api/deposit`,
    JSON.stringify({ amount: '1', token: 'USDC' }),
    { headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${__ENV.TEST_JWT || 'stress-token'}`,
      },
      timeout: '15s',
    },
  )
  check(deposit, { 'deposit responded': (r) => r.status !== 0 })
  errorRate.add(deposit.status >= 500)

  sleep(0.5)
}
