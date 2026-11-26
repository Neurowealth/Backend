/**
 * PDF export load test (#670).
 *
 * Verifies the concurrency cap and the documented memory ceiling: the server
 * must answer 200 or 429 (never 5xx / OOM) when many clients request
 * maximum-size PDFs at once. Run against a disposable environment:
 *
 *   k6 run tests/load/pdf-export.js \
 *     -e BASE_URL=http://localhost:3000 \
 *     -e TEST_JWT=<jwt> \
 *     -e EXPORT_PATH=/api/v1/analytics/user-yield/export
 *
 * Watch server RSS (`docker stats`, `kubectl top pod`) and confirm it stays
 * below the idle footprint + ~150 MiB documented in docs/PDF_EXPORTS.md.
 */
import http from 'k6/http'
import { check } from 'k6'
import { Rate, Trend } from 'k6/metrics'

const accepted = new Rate('pdf_accepted')
const throttled = new Rate('pdf_throttled')
const pdfLatency = new Trend('pdf_latency', true)

export const options = {
  scenarios: {
    burst: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '15s', target: 20 },
        { duration: '45s', target: 20 },
        { duration: '15s', target: 0 },
      ],
    },
  },
  thresholds: {
    pdf_accepted: ['rate>0.5'],
    http_req_failed: ['rate==0'],
    pdf_latency: ['p(95)<15000'],
    checks: ['rate==1'],
  },
}

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000'
const EXPORT_PATH = __ENV.EXPORT_PATH || '/api/v1/analytics/user-yield/export'
const AUTH = __ENV.TEST_JWT ? { Authorization: `Bearer ${__ENV.TEST_JWT}` } : {}
const YEAR = new Date().getUTCFullYear()
const URL = `${BASE_URL}${EXPORT_PATH}?format=pdf&from=${YEAR}-01-01&to=${YEAR}-12-31`

export default function () {
  const res = http.get(URL, { headers: AUTH, timeout: '60s' })
  pdfLatency.add(res.timings.duration)
  accepted.add(res.status === 200)
  throttled.add(res.status === 429)

  check(res, {
    '200 or explicit throttle': (r) => r.status === 200 || r.status === 429,
    'no 5xx': (r) => r.status < 500,
    'throttle carries Retry-After': (r) =>
      r.status !== 429 || Boolean(r.headers['Retry-After']),
    'pdf content type on success': (r) =>
      r.status !== 200 || r.headers['Content-Type'] === 'application/pdf',
    'no-store on success': (r) =>
      r.status !== 200 ||
      (r.headers['Cache-Control'] || '').includes('no-store'),
  })
}
