/**
 * Integration tests for GET /metrics
 * Covers: authorization behavior, response status codes, and Prometheus text format.
 * Issue #187
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
    const token = process.env.INTERNAL_SERVICE_TOKEN

    beforeAll(() => {
      if (!token)
        console.warn(
          'Skipping authorized tests: INTERNAL_SERVICE_TOKEN not set'
        )
    })

    it('returns 200 with valid X-Internal-Token', async () => {
      if (!token) return
      const res = await request(app)
        .get('/metrics')
        .set('X-Internal-Token', token)
      expect(res.status).toBe(200)
    })

    it('returns text/plain content-type', async () => {
      if (!token) return
      const res = await request(app)
        .get('/metrics')
        .set('X-Internal-Token', token)
      expect(res.headers['content-type']).toMatch(/text\/plain/)
    })

    it('returns Prometheus-compatible exposition format', async () => {
      if (!token) return
      const res = await request(app)
        .get('/metrics')
        .set('X-Internal-Token', token)
      // Prometheus text format starts with # HELP or # TYPE lines
      expect(res.text).toMatch(/^#\s+(HELP|TYPE)\s+\w+/m)
    })
  })

  describe('authorized access via Bearer (admin) token', () => {
    const token = process.env.ADMIN_API_TOKEN

    beforeAll(() => {
      if (!token)
        console.warn('Skipping authorized tests: ADMIN_API_TOKEN not set')
    })

    it('returns 200 with valid ADMIN_API_TOKEN as Bearer', async () => {
      if (!token) return
      const res = await request(app)
        .get('/metrics')
        .set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(200)
    })

    it('returns Prometheus-compatible text with admin token', async () => {
      if (!token) return
      const res = await request(app)
        .get('/metrics')
        .set('Authorization', `Bearer ${token}`)
      expect(res.text).toMatch(/^#\s+(HELP|TYPE)\s+\w+/m)
    })
  })
})
