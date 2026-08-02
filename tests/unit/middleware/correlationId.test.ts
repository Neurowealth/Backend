import { Request, Response, NextFunction } from 'express'
import {
  correlationIdMiddleware,
  REQUEST_ID_HEADER,
} from '../../../src/middleware/correlationId'
import {
  isValidCorrelationId,
  generateCorrelationId,
} from '../../../src/utils/correlation'

describe('correlation utilities', () => {
  it('accepts UUID-shaped IDs', () => {
    expect(isValidCorrelationId('550e8400-e29b-41d4-a716-446655440000')).toBe(
      true
    )
  })

  it('accepts alphanumeric request IDs up to 128 chars', () => {
    expect(isValidCorrelationId('req-abc_123')).toBe(true)
  })

  it('rejects IDs over 128 characters', () => {
    expect(isValidCorrelationId('a'.repeat(129))).toBe(false)
  })

  it('rejects IDs with invalid characters', () => {
    expect(isValidCorrelationId('bad id with spaces')).toBe(false)
  })

  it('generates valid UUIDs', () => {
    const id = generateCorrelationId()
    expect(isValidCorrelationId(id)).toBe(true)
  })
})

describe('correlationIdMiddleware', () => {
  let req: Partial<Request>
  let res: Partial<Response>
  let next: NextFunction

  beforeEach(() => {
    req = { headers: {} }
    res = {
      locals: {},
      setHeader: jest.fn(),
    }
    next = jest.fn()
  })

  it('preserves a client-supplied X-Request-ID', () => {
    const clientId = '550e8400-e29b-41d4-a716-446655440000'
    req.headers = { 'x-request-id': clientId }

    correlationIdMiddleware(req as Request, res as Response, next)

    expect(req.correlationId).toBe(clientId)
    expect(res.locals?.correlationId).toBe(clientId)
    expect(res.setHeader).toHaveBeenCalledWith(REQUEST_ID_HEADER, clientId)
    expect(next).toHaveBeenCalled()
  })

  it('accepts X-Correlation-ID when X-Request-ID is absent', () => {
    const clientId = 'client-correlation-001'
    req.headers = { 'x-correlation-id': clientId }

    correlationIdMiddleware(req as Request, res as Response, next)

    expect(req.correlationId).toBe(clientId)
    expect(res.setHeader).toHaveBeenCalledWith(REQUEST_ID_HEADER, clientId)
  })

  it('generates a UUID when no header is provided', () => {
    correlationIdMiddleware(req as Request, res as Response, next)

    expect(req.correlationId).toBeDefined()
    expect(isValidCorrelationId(req.correlationId!)).toBe(true)
    expect(res.setHeader).toHaveBeenCalledWith(
      REQUEST_ID_HEADER,
      req.correlationId
    )
  })

  it('generates a new ID when the client header is invalid', () => {
    req.headers = { 'x-request-id': 'not valid!!!' }

    correlationIdMiddleware(req as Request, res as Response, next)

    expect(req.correlationId).not.toBe('not valid!!!')
    expect(isValidCorrelationId(req.correlationId!)).toBe(true)
  })
})
