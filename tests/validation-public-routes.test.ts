/**
 * Tests for Zod validation on public routes.
 * Verifies that invalid payloads return 400 with a descriptive error body.
 * Issue #146
 */

import request from 'supertest'
import app from '../src/index'

describe('Zod validation on public routes', () => {
  describe('POST /api/v1/auth/challenge', () => {
    it('returns 400 when stellarPubKey is missing', async () => {
      const res = await request(app).post('/api/v1/auth/challenge').send({})
      expect(res.status).toBe(400)
      expect(res.body.error).toBeDefined()
      expect(res.body.details).toBeDefined()
    })

    it('returns 400 when stellarPubKey is empty string', async () => {
      const res = await request(app)
        .post('/api/v1/auth/challenge')
        .send({ stellarPubKey: '' })
      expect(res.status).toBe(400)
      expect(res.body.details).toBeDefined()
    })

    it('passes validation with a non-empty stellarPubKey', async () => {
      // The key is invalid Stellar format so we get 400 from the controller,
      // but the Zod middleware layer should not be the one rejecting it.
      const res = await request(app)
        .post('/api/v1/auth/challenge')
        .send({ stellarPubKey: 'GNOTAVALIDKEY' })
      // 400 from controller (invalid Stellar key format), not from validation layer
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('Invalid Stellar public key')
    })
  })

  describe('POST /api/v1/auth/verify', () => {
    it('returns 400 when both fields are missing', async () => {
      const res = await request(app).post('/api/v1/auth/verify').send({})
      expect(res.status).toBe(400)
      expect(res.body.error).toBeDefined()
      expect(res.body.details).toBeDefined()
    })

    it('returns 400 when signature is missing', async () => {
      const res = await request(app)
        .post('/api/v1/auth/verify')
        .send({ stellarPubKey: 'GXXXXXX' })
      expect(res.status).toBe(400)
      expect(res.body.details).toBeDefined()
    })

    it('returns 400 when stellarPubKey is missing', async () => {
      const res = await request(app)
        .post('/api/v1/auth/verify')
        .send({ signature: 'abc123' })
      expect(res.status).toBe(400)
      expect(res.body.details).toBeDefined()
    })
  })

  describe('POST /api/v1/whatsapp/webhook', () => {
    it('returns 400 when From is missing', async () => {
      const res = await request(app)
        .post('/api/v1/whatsapp/webhook')
        .send({ Body: 'hello' })
      expect(res.status).toBe(400)
      expect(res.body.error).toBeDefined()
    })

    it('returns 400 when Body is missing', async () => {
      const res = await request(app)
        .post('/api/v1/whatsapp/webhook')
        .send({ From: '+1234567890' })
      expect(res.status).toBe(400)
      expect(res.body.error).toBeDefined()
    })
  })
})
