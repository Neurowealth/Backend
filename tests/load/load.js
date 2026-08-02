/**
 * Load test — 50 VUs × 10 minutes (typical production traffic).
 *
 * Purpose: validate that rate limiter, connection pool, and circuit breaker
 * behave correctly under sustained production-level concurrency.
 * Run:     k6 run tests/load/load.js -e BASE_URL=http://localhost:3000
 */
import http from 'k6/http'
import { check, group, sleep } from 'k6'
import { Rate, Trend, Counter } from 'k6/metrics'

const errorRate = new Rate('errors')
const portfolioLatency = new Trend('portfolio_latency', true)
const depositLatency = new Trend('deposit_latency', true)
const rateLimitHits = new Counter('rate_limit_hits')

export const options = {
  stages: [
    { duration: '1m', target: 50 },   // ramp up
    { duration: '8m', target: 50 },   // sustained load
    { duration: '1m', target: 0 },    // ramp down
  ],

  thresholds: {
    // SLO gates defined in docs/SLO_GUIDANCE.md
    http_req_failed: ['rate<0.01'],
    errors: ['rate<0.01'],
    portfolio_latency: ['p(95)<500', 'p(99)<750'],
    deposit_latency: ['p(95)<500', 'p(99)<2000'],
    http_req_duration: ['p(95)<500'],
  },
}

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000'

export default function () {
  group('read path', () => {
    const portfolio = http.get(`${BASE_URL}/api/portfolio`, {
      headers: { Authorization: `Bearer ${__ENV.TEST_JWT || 'load-token'}` },
    })
    portfolioLatency.add(portfolio.timings.duration)
    if (portfolio.status === 429) rateLimitHits.add(1)
    check(portfolio, {
      'portfolio not 5xx': (r) => r.status < 500,
    })
    errorRate.add(portfolio.status >= 500)
    sleep(0.5)

    const transactions = http.get(`${BASE_URL}/api/transactions`, {
      headers: { Authorization: `Bearer ${__ENV.TEST_JWT || 'load-token'}` },
    })
    check(transactions, { 'transactions not 5xx': (r) => r.status < 500 })
    errorRate.add(transactions.status >= 500)
    sleep(0.5)
  })

  group('write path', () => {
    const deposit = http.post(
      `${BASE_URL}/api/deposit`,
      JSON.stringify({ amount: '10', token: 'USDC' }),
      { headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${__ENV.TEST_JWT || 'load-token'}`,
        },
      },
    )
    depositLatency.add(deposit.timings.duration)
    if (deposit.status === 429) rateLimitHits.add(1)
    check(deposit, { 'deposit not 5xx': (r) => r.status < 500 })
    errorRate.add(deposit.status >= 500)
    sleep(1)
  })
}
