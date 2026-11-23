/**
 * Integration tests for GET /metrics
 * Covers: authorization behavior, response status codes, and Prometheus text format.
 * Issue #187, #797
 *
 * The tokens come from .env.test, which tests/setup-env.ts loads before any
 * test module is imported. That ordering matters: src/config/env.ts snapshots
 * the values when the app module loads, so assigning them in beforeAll would
 * be too late. beforeAll below asserts they are present instead of skipping
 * the authorized cases (#797).
 */

import request from 'supertest'
import app from '../src/index'

describe('GET /metrics', () => {
  describe('unauthorized access', () => {
    it('returns 404 with no credentials', async () => {
      const res = await request(app).get('/metrics')
      expect(res.status).toBe(404)
      expect(res.body.error).toBeDefined()
    })

    it('returns 404 with invalid X-Internal-Token', async () => {
      const res = await request(app)
        .get('/metrics')
        .set('X-Internal-Token', 'bad-token')
      expect(res.status).toBe(404)
    })

    it('returns 404 with invalid Bearer token', async () => {
      const res = await request(app)
        .get('/metrics')
        .set('Authorization', 'Bearer bad-token')
      expect(res.status).toBe(404)
    })
  })

  describe('authorized access via X-Internal-Token', () => {
    let token: string

    beforeAll(() => {
      token = process.env.INTERNAL_SERVICE_TOKEN || ''
      expect(token).not.toBe('')
    })

    it('returns 200 with valid X-Internal-Token', async () => {
      const res = await request(app)
        .get('/metrics')
        .set('X-Internal-Token', token)
      expect(res.status).toBe(200)
    })

    it('returns text/plain content-type', async () => {
      const res = await request(app)
        .get('/metrics')
        .set('X-Internal-Token', token)
      expect(res.headers['content-type']).toMatch(/text\/plain/)
    })

    it('returns Prometheus-compatible exposition format', async () => {
      const res = await request(app)
        .get('/metrics')
        .set('X-Internal-Token', token)
      // Prometheus text format starts with # HELP or # TYPE lines
      expect(res.text).toMatch(/^#\s+(HELP|TYPE)\s+\w+/m)
    })
  })

  describe('authorized access via Bearer (admin) token', () => {
    let token: string

    beforeAll(() => {
      token = process.env.ADMIN_API_TOKEN || ''
      expect(token).not.toBe('')
    })

    it('returns 200 with valid ADMIN_API_TOKEN as Bearer', async () => {
      const res = await request(app)
        .get('/metrics')
        .set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(200)
    })

    it('returns Prometheus-compatible text with admin token', async () => {
      const res = await request(app)
        .get('/metrics')
        .set('Authorization', `Bearer ${token}`)
      expect(res.text).toMatch(/^#\s+(HELP|TYPE)\s+\w+/m)
    })

    it('returns 404 when the Bearer token is not the admin token', async () => {
      const res = await request(app)
        .get('/metrics')
        .set('Authorization', `Bearer wrong-${token}`)
      expect(res.status).toBe(404)
    })
  })
})
