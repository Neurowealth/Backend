/**
 * Unit-level proof that the routes probed by api-contract.yml are genuinely
 * protected (#798). The CI probe verifies the mounted v1 paths; this test
 * verifies the middleware behaviour behind them without a live server.
 */
process.env.NODE_ENV = 'test'

import express from 'express'
import request from 'supertest'
import vaultRouter from '../../../src/routes/vault'
import transactionsRouter from '../../../src/routes/transactions'

const app = express()
app.use(express.json())
app.use('/api/v1/vault', vaultRouter)
app.use('/api/v1/transactions', transactionsRouter)

describe('protected route contract (#798)', () => {
  it.each(['/api/v1/vault/balance', '/api/v1/transactions/detail/x'])(
    'returns exactly 401 without credentials for %s',
    async (route) => {
      const res = await request(app).get(route)
      expect(res.status).toBe(401)
    }
  )
})
