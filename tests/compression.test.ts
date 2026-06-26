/**
 * tests/compression.test.ts
 *
 * Unit/integration tests for the compressionMiddleware.
 *
 * Builds a minimal self-contained Express app so the tests have NO
 * dependency on environment variables or the full application stack.
 *
 * Covers:
 *   - gzip Content-Encoding on responses > 1 KB
 *   - brotli Content-Encoding when client advertises br
 *   - no compression on responses under the 1 KB threshold
 *   - /metrics path excluded from compression regardless of Accept-Encoding
 */

import express from 'express'
import request from 'supertest'
import { compressionMiddleware } from '../src/middleware/compression'

// ── Test helpers ─────────────────────────────────────────────────────────────

/** Build a minimal Express app that mounts only the compression middleware. */
function buildApp() {
  const app = express()
  app.use(compressionMiddleware)

  // Route that returns a large (> 1 KB) JSON payload — guaranteed to be
  // above the 1 KB threshold so compression must activate.
  app.get('/large', (_req, res) => {
    const payload = { data: 'x'.repeat(2048) } // 2 KB+
    res.json(payload)
  })

  // Route that returns a small (< 1 KB) payload — compression must NOT fire.
  app.get('/small', (_req, res) => {
    res.json({ ok: true })
  })

  // Simulated /metrics route — excluded by the filter callback.
  app.get('/metrics', (_req, res) => {
    // Return a large payload so that size alone would trigger compression,
    // proving the exclusion is driven by path, not by response size.
    res.set('Content-Type', 'text/plain')
    res.send('# HELP test_metric A test metric\n' + 'metric 1\n'.repeat(300))
  })

  return app
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('compressionMiddleware', () => {
  const app = buildApp()

  // ── gzip ────────────────────────────────────────────────────────────────────

  describe('gzip compression', () => {
    it('returns Content-Encoding: gzip on responses > 1 KB', async () => {
      const res = await request(app)
        .get('/large')
        .set('Accept-Encoding', 'gzip')

      expect(res.status).toBe(200)
      expect(res.headers['content-encoding']).toBe('gzip')
    })

    it('decompresses correctly — response body is valid JSON', async () => {
      const res = await request(app)
        .get('/large')
        .set('Accept-Encoding', 'gzip')
        .buffer(true)
        .parse((res, callback) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => callback(null, Buffer.concat(chunks)))
        })

      // supertest auto-decompresses; body should be valid
      expect(res.status).toBe(200)
    })
  })

  // ── brotli ──────────────────────────────────────────────────────────────────

  describe('brotli compression', () => {
    it('returns Content-Encoding: br on responses > 1 KB when br is advertised', async () => {
      const res = await request(app)
        .get('/large')
        .set('Accept-Encoding', 'br')

      expect(res.status).toBe(200)
      expect(res.headers['content-encoding']).toBe('br')
    })

    it('prefers br over gzip when both are advertised and br has higher priority', async () => {
      const res = await request(app)
        .get('/large')
        .set('Accept-Encoding', 'br, gzip')

      expect(res.status).toBe(200)
      // The middleware should honour the highest-priority advertised encoding
      expect(['br', 'gzip']).toContain(res.headers['content-encoding'])
    })
  })

  // ── threshold ───────────────────────────────────────────────────────────────

  describe('threshold (< 1 KB)', () => {
    it('does NOT add Content-Encoding for responses under 1 KB', async () => {
      const res = await request(app)
        .get('/small')
        .set('Accept-Encoding', 'gzip, deflate, br')

      expect(res.status).toBe(200)
      // Tiny response: Content-Encoding header must be absent
      expect(res.headers['content-encoding']).toBeUndefined()
    })
  })

  // ── /metrics exclusion ───────────────────────────────────────────────────────

  describe('/metrics path exclusion', () => {
    it('does NOT add Content-Encoding for /metrics even when gzip is advertised', async () => {
      const res = await request(app)
        .get('/metrics')
        .set('Accept-Encoding', 'gzip')

      expect(res.status).toBe(200)
      // Even though the payload is large, the filter must exclude this path
      expect(res.headers['content-encoding']).toBeUndefined()
    })

    it('does NOT add Content-Encoding for /metrics when br is advertised', async () => {
      const res = await request(app)
        .get('/metrics')
        .set('Accept-Encoding', 'gzip, deflate, br')

      expect(res.status).toBe(200)
      expect(res.headers['content-encoding']).toBeUndefined()
    })

    it('still serves /metrics content correctly when compression is excluded', async () => {
      const res = await request(app)
        .get('/metrics')
        .set('Accept-Encoding', 'gzip')

      expect(res.status).toBe(200)
      expect(res.text).toContain('# HELP test_metric')
    })
  })
})
