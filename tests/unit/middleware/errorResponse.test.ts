import express, { NextFunction, Request, Response } from 'express'
import request from 'supertest'
import { z } from 'zod'
import { correlationIdMiddleware } from '../../../src/middleware/correlationId'
import {
  errorResponseMiddleware,
  notFoundHandler,
} from '../../../src/middleware/errorResponse'
import { errorHandler } from '../../../src/middleware/errorHandler'
import { validate } from '../../../src/middleware/validate'
import { AppError } from '../../../src/utils/errors'
import { normalizeErrorBody } from '../../../src/utils/errorResponse'

jest.mock('../../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}))

jest.mock('../../../src/telemetry/sentry', () => ({
  Sentry: {
    withScope: jest.fn((cb: (scope: unknown) => void) =>
      cb({ setUser: jest.fn(), setTag: jest.fn(), setContext: jest.fn() })
    ),
    captureException: jest.fn(),
  },
}))

const REQUEST_ID = 'req-test-123'

function buildApp(): express.Express {
  const app = express()
  app.use(correlationIdMiddleware)
  app.use(errorResponseMiddleware)
  app.use(express.json())

  app.get('/legacy', (_req, res) => {
    res.status(403).json({ success: false, error: 'Admin only' })
  })
  app.get('/leaky', (_req, res) => {
    res.status(500).json({ error: 'connect ECONNREFUSED 10.0.0.5:5432' })
  })
  app.get('/ok', (_req, res) => {
    res.json({ error: 'not an error — 200 bodies are untouched' })
  })
  app.get('/health/ready', (_req, res) => {
    res.status(503).json({ status: 'not_ready' })
  })
  app.post(
    '/validated',
    validate({ body: z.object({ amount: z.number().positive() }) }),
    (_req, res) => {
      res.json({ ok: true })
    }
  )
  app.get('/app-error', (_req, _res, next: NextFunction) => {
    next(new AppError(409, 'Goal already exists', { goalId: 'g1' }))
  })
  app.get('/zod-throw', () => {
    z.object({ userId: z.string() }).parse({})
  })
  app.get('/boom', () => {
    const err = new Error('password=hunter2 in SELECT * FROM users')
    throw err
  })
  app.post('/json', (req: Request, res: Response) => {
    res.json(req.body)
  })

  app.use(notFoundHandler)
  app.use(errorHandler)
  return app
}

function expectEnvelope(body: Record<string, unknown>, status: number) {
  expect(body.status).toBe(status)
  expect(typeof body.code).toBe('string')
  expect(typeof body.message).toBe('string')
  expect(body.error).toBe(body.message)
  expect(body.requestId).toBe(REQUEST_ID)
  expect(typeof body.timestamp).toBe('string')
  expect(body).not.toHaveProperty('stack')
}

describe('standardized error responses', () => {
  const app = buildApp()
  const get = (path: string) =>
    request(app).get(path).set('X-Request-ID', REQUEST_ID)

  it('normalizes legacy { error } bodies and keeps extra fields', async () => {
    const res = await get('/legacy')
    expect(res.status).toBe(403)
    expectEnvelope(res.body, 403)
    expect(res.body.code).toBe('FORBIDDEN')
    expect(res.body.message).toBe('Admin only')
    expect(res.body.success).toBe(false)
  })

  it('sanitizes handler-produced 500 messages', async () => {
    const res = await get('/leaky')
    expect(res.status).toBe(500)
    expectEnvelope(res.body, 500)
    expect(res.body.code).toBe('INTERNAL_ERROR')
    expect(res.body.message).toBe('Internal server error')
    expect(JSON.stringify(res.body)).not.toContain('ECONNREFUSED')
  })

  it('does not touch successful responses', async () => {
    const res = await get('/ok')
    expect(res.body).toEqual({
      error: 'not an error — 200 bodies are untouched',
    })
  })

  it('leaves health probe payloads alone', async () => {
    const res = await get('/health/ready')
    expect(res.status).toBe(503)
    expect(res.body).toEqual({ status: 'not_ready' })
  })

  it('returns field-level details for validation failures', async () => {
    const res = await request(app)
      .post('/validated')
      .set('X-Request-ID', REQUEST_ID)
      .send({ amount: -5 })
    expect(res.status).toBe(400)
    expectEnvelope(res.body, 400)
    expect(res.body.code).toBe('VALIDATION_ERROR')
    expect(res.body.details).toEqual([
      expect.objectContaining({ field: 'amount', message: expect.any(String) }),
    ])
  })

  it('maps thrown AppErrors to their status with details', async () => {
    const res = await get('/app-error')
    expect(res.status).toBe(409)
    expectEnvelope(res.body, 409)
    expect(res.body.code).toBe('CONFLICT')
    expect(res.body.message).toBe('Goal already exists')
    expect(res.body.details).toEqual({ goalId: 'g1' })
  })

  it('maps thrown ZodErrors to 400 validation errors', async () => {
    const res = await get('/zod-throw')
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('VALIDATION_ERROR')
    expect(res.body.details[0].field).toBe('userId')
  })

  it('converts unhandled errors to sanitized 500s', async () => {
    const res = await get('/boom')
    expect(res.status).toBe(500)
    expectEnvelope(res.body, 500)
    expect(res.body.message).toBe('Internal server error')
    expect(JSON.stringify(res.body)).not.toContain('hunter2')
  })

  it('returns a clean 400 for malformed JSON', async () => {
    const res = await request(app)
      .post('/json')
      .set('X-Request-ID', REQUEST_ID)
      .set('Content-Type', 'application/json')
      .send('{"broken":')
    expect(res.status).toBe(400)
    expectEnvelope(res.body, 400)
    expect(res.body.message).toBe('Malformed JSON request body')
  })

  it('returns 404 envelopes for unknown routes', async () => {
    const res = await get('/does-not-exist')
    expect(res.status).toBe(404)
    expectEnvelope(res.body, 404)
    expect(res.body.code).toBe('NOT_FOUND')
    expect(res.headers['x-request-id']).toBe(REQUEST_ID)
  })
})

describe('normalizeErrorBody', () => {
  const opts = { sanitizeInternal: true }

  it('unwraps the previous nested { error: { code, message } } shape', () => {
    const body = normalizeErrorBody(
      429,
      { error: { code: 'RATE_LIMITED', message: 'Slow down' } },
      'r1',
      opts
    )
    expect(body).toMatchObject({
      status: 429,
      code: 'RATE_LIMITED',
      message: 'Slow down',
      error: 'Slow down',
      requestId: 'r1',
    })
  })

  it('keeps domain-specific string codes', () => {
    const body = normalizeErrorBody(
      400,
      { error: 'Insufficient balance', code: 'INSUFFICIENT_FUNDS' },
      'r1',
      opts
    )
    expect(body.code).toBe('INSUFFICIENT_FUNDS')
  })

  it('falls back to a status message for empty bodies', () => {
    const body = normalizeErrorBody(401, undefined, 'r1', opts)
    expect(body).toMatchObject({
      status: 401,
      code: 'UNAUTHORIZED',
      message: 'Unauthorized',
    })
  })

  it('keeps 500 messages in development', () => {
    const body = normalizeErrorBody(500, { error: 'db down' }, 'r1', {
      sanitizeInternal: false,
    })
    expect(body.message).toBe('db down')
  })
})
