// requestLogger samples healthy requests (LOG_SAMPLE_RATE, default 0.1) and
// reads the rate at module load — force full logging BEFORE the import below
// so the log assertion is deterministic.
process.env.LOG_SAMPLE_RATE = '1'

import express from 'express'
import request from 'supertest'
import { correlationIdMiddleware } from '../../src/middleware/correlationId'
import { requestLogger } from '../../src/middleware/logger'
import { logger } from '../../src/utils/logger'

jest.mock('../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
  },
  createCorrelatedLogger: jest.fn(),
}))

describe('correlation ID integration', () => {
  const clientId = '550e8400-e29b-41d4-a716-446655440000'

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('propagates a single request ID through response header, handler, and logs', async () => {
    const app = express()
    app.use(correlationIdMiddleware)
    app.use(requestLogger)

    const downstreamHandler = jest.fn((req, res) => {
      res.json({ requestId: req.correlationId })
    })

    app.get('/test', downstreamHandler)

    const res = await request(app).get('/test').set('X-Request-ID', clientId)

    expect(res.status).toBe(200)
    expect(res.headers['x-request-id']).toBe(clientId)
    expect(res.body.requestId).toBe(clientId)
    expect(downstreamHandler).toHaveBeenCalledTimes(1)

    expect(logger.info).toHaveBeenCalledWith(
      'GET /test',
      expect.objectContaining({
        correlationId: clientId,
        status: 200,
      })
    )
  })
})
