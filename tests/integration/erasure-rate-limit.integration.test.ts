import express from 'express'
import request from 'supertest'
import { erasureRateLimiter } from '../../src/middleware/rateLimiter'

describe('erasureRateLimiter', () => {
  it('rejects the sixth erasure call inside the window', async () => {
    const app = express()
    app.post('/erasure', erasureRateLimiter, (_req, res) => {
      res.json({ ok: true })
    })

    for (let i = 0; i < 5; i++) {
      expect((await request(app).post('/erasure')).status).toBe(200)
    }
    expect((await request(app).post('/erasure')).status).toBe(429)
  })
})
