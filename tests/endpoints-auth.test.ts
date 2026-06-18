/**
 * Integration tests for protected internal endpoints
 * Tests that /metrics and /api/agent/status properly reject unauthorized access
 */

import request from 'supertest'
import app from '../src/index'

describe('Internal Endpoint Authentication', () => {
  describe('GET /metrics', () => {
    it('should return 404 without valid credentials', async () => {
      const res = await request(app).get('/metrics')
      expect(res.status).toBe(404)
      expect(res.body.error).toBeDefined()
    })

    it('should return 404 with invalid X-Internal-Token', async () => {
      const res = await request(app)
        .get('/metrics')
        .set('X-Internal-Token', 'invalid-token')
      expect(res.status).toBe(404)
    })

    it('should return 404 with invalid Bearer token', async () => {
      const res = await request(app)
        .get('/metrics')
        .set('Authorization', 'Bearer invalid-token')
      expect(res.status).toBe(404)
    })

    it('should return 200 with valid X-Internal-Token', async () => {
      const token = process.env.INTERNAL_SERVICE_TOKEN
      if (!token) {
        console.log('Skipping: INTERNAL_SERVICE_TOKEN not set')
        return
      }
      const res = await request(app)
        .get('/metrics')
        .set('X-Internal-Token', token)
      expect(res.status).toBe(200)
      expect(res.text).toContain('# HELP')
    })

    it('should return 200 with valid Bearer token', async () => {
      const token = process.env.ADMIN_API_TOKEN
      if (!token) {
        console.log('Skipping: ADMIN_API_TOKEN not set')
        return
      }
      const res = await request(app)
        .get('/metrics')
        .set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(200)
      expect(res.text).toContain('# HELP')
    })
  })

  describe('GET /api/agent/status', () => {
    it('should return 403 without valid credentials', async () => {
      const res = await request(app).get('/api/agent/status')
      expect(res.status).toBe(403)
      expect(res.body.error).toBe('Forbidden')
    })

    it('should return 403 with invalid X-Internal-Token', async () => {
      const res = await request(app)
        .get('/api/agent/status')
        .set('X-Internal-Token', 'invalid-token')
      expect(res.status).toBe(403)
    })

    it('should return 403 with invalid Bearer token', async () => {
      const res = await request(app)
        .get('/api/agent/status')
        .set('Authorization', 'Bearer invalid-token')
      expect(res.status).toBe(403)
    })

    it('should return 200 with valid X-Internal-Token', async () => {
      const token = process.env.INTERNAL_SERVICE_TOKEN
      if (!token) {
        console.log('Skipping: INTERNAL_SERVICE_TOKEN not set')
        return
      }
      const res = await request(app)
        .get('/api/agent/status')
        .set('X-Internal-Token', token)
      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data).toBeDefined()
    })

    it('should return 200 with valid Bearer token', async () => {
      const token = process.env.ADMIN_API_TOKEN
      if (!token) {
        console.log('Skipping: ADMIN_API_TOKEN not set')
        return
      }
      const res = await request(app)
        .get('/api/agent/status')
        .set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
    })
  })
})
