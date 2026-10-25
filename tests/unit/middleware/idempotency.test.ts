import {
  idempotent,
  computeFingerprint,
  canonicalizeBody,
} from '../../../src/middleware/idempotency'
import { getRedisClient } from '../../../src/config/redis'
import { Request, Response, NextFunction } from 'express'
import db from '../../../src/db'

jest.mock('../../../src/config/redis', () => ({
  getRedisClient: jest.fn(),
}))

jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: {
    idempotencyRecord: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
    },
  },
}))

describe('Idempotency middleware (#375, #483)', () => {
  let req: Partial<Request>
  let res: Partial<Response>
  let next: NextFunction
  let mockRedis: { get: jest.Mock; set: jest.Mock }

  beforeEach(() => {
    mockRedis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
    }
    ;(getRedisClient as jest.Mock).mockReturnValue(mockRedis)
    ;(db.idempotencyRecord.findUnique as jest.Mock).mockResolvedValue(null)
    ;(db.idempotencyRecord.upsert as jest.Mock).mockResolvedValue({})

    req = {
      method: 'POST',
      path: '/deposit',
      body: { amount: 100, assetSymbol: 'USDC' },
      auth: {
        userId: 'user-1',
        sessionId: 's1',
        walletAddress: 'G...',
        network: 'MAINNET',
      },
      header: jest.fn((name: string) => {
        if (name === 'Idempotency-Key') return 'key-abc'
        return undefined
      }) as any,
    }
    res = {
      statusCode: 200,
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      setHeader: jest.fn(),
    }
    next = jest.fn()
    jest.clearAllMocks()
  })

  it('passes through when header is absent and not required', async () => {
    req.header = jest.fn().mockReturnValue(undefined) as any
    await idempotent({ required: false })(req as Request, res as Response, next)
    expect(next).toHaveBeenCalled()
  })

  it('returns 400 when header is required but missing', async () => {
    req.header = jest.fn().mockReturnValue(undefined) as any
    await idempotent({ required: true })(req as Request, res as Response, next)
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'idempotency_key_required' })
  })

  it('returns 400 when idempotency key exceeds 255 characters', async () => {
    const longKey = 'a'.repeat(256)
    req.header = jest.fn((name: string) => {
      if (name === 'Idempotency-Key') return longKey
      return undefined
    }) as any
    await idempotent({ required: true })(req as Request, res as Response, next)
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'idempotency_key_too_long' })
  })

  it('returns 401 when userId is missing', async () => {
    delete req.auth
    await idempotent({ required: true })(req as Request, res as Response, next)
    expect(res.status).toHaveBeenCalledWith(401)
    expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' })
  })

  it('acquires lock and calls next on first request', async () => {
    await idempotent({ required: true })(req as Request, res as Response, next)
    expect(mockRedis.set).toHaveBeenCalledWith(
      'idem:user-1:key-abc',
      expect.any(String),
      'PX',
      30000,
      'NX'
    )
    expect(next).toHaveBeenCalled()
  })

  it('replays completed response on duplicate submission with matching fingerprint', async () => {
    const fingerprint = computeFingerprint(req as Request, 'user-1')
    mockRedis.get.mockResolvedValue(
      JSON.stringify({
        fingerprint,
        status: 'completed',
        statusCode: 201,
        responseBody: { id: 'deposit-123', status: 'SUCCESS' },
      })
    )

    await idempotent({ required: true })(req as Request, res as Response, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.setHeader).toHaveBeenCalledWith('Idempotency-Replayed', 'true')
    expect(res.status).toHaveBeenCalledWith(201)
    expect(res.json).toHaveBeenCalledWith({
      id: 'deposit-123',
      status: 'SUCCESS',
    })
  })

  it('rejects with 422 idempotency_key_reuse when same key is submitted with different payload', async () => {
    mockRedis.get.mockResolvedValue(
      JSON.stringify({
        fingerprint: 'different-fingerprint-from-other-request',
        status: 'completed',
        statusCode: 200,
        responseBody: { id: 'deposit-999' },
      })
    )

    await idempotent({ required: true })(req as Request, res as Response, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(422)
    expect(res.json).toHaveBeenCalledWith({ error: 'idempotency_key_reuse' })
  })

  it('returns 409 when request with same key is currently in_progress', async () => {
    mockRedis.get.mockResolvedValue(
      JSON.stringify({
        fingerprint: 'some-fingerprint',
        status: 'in_progress',
      })
    )

    await idempotent({ required: true })(req as Request, res as Response, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(409)
    expect(res.json).toHaveBeenCalledWith({
      error: 'idempotency_request_in_flight',
    })
  })

  it('falls back to database when Redis misses', async () => {
    const fingerprint = computeFingerprint(req as Request, 'user-1')
    mockRedis.get.mockResolvedValue(null)
    ;(db.idempotencyRecord.findUnique as jest.Mock).mockResolvedValue({
      fingerprint,
      status: 'completed',
      statusCode: 200,
      responseBody: { replayedFromDb: true },
      expiresAt: new Date(Date.now() + 60000),
    })

    await idempotent({ required: true })(req as Request, res as Response, next)

    expect(res.setHeader).toHaveBeenCalledWith('Idempotency-Replayed', 'true')
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({ replayedFromDb: true })
  })

  it('intercepts res.json to cache response in Redis and DB upon completion', async () => {
    await idempotent({ required: true })(req as Request, res as Response, next)
    expect(next).toHaveBeenCalled()

    // Trigger intercepted res.json
    res.statusCode = 201
    res.json!({ success: true, txId: 'tx-1' })

    expect(mockRedis.set).toHaveBeenCalledWith(
      'idem:user-1:key-abc',
      expect.stringContaining('"status":"completed"'),
      'EX',
      86400
    )
    expect(db.idempotencyRecord.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId_idempotencyKey: {
            userId: 'user-1',
            idempotencyKey: 'key-abc',
          },
        },
      })
    )
  })

  it('returns 503 when failClosed and no redis', async () => {
    ;(getRedisClient as jest.Mock).mockReturnValue(null)
    await idempotent({ required: true, failClosed: true })(
      req as Request,
      res as Response,
      next
    )
    expect(res.status).toHaveBeenCalledWith(503)
    expect(res.json).toHaveBeenCalledWith({
      error: 'Idempotency store unavailable',
    })
  })

  describe('canonicalizeBody', () => {
    it('sorts keys regardless of insertion order', () => {
      const a = canonicalizeBody({ b: 2, a: 1, c: { z: 9, y: 8 } })
      const b = canonicalizeBody({ a: 1, c: { y: 8, z: 9 }, b: 2 })
      expect(a).toBe(b)
    })

    it('handles empty and null bodies', () => {
      expect(canonicalizeBody(null)).toBe('')
      expect(canonicalizeBody(undefined)).toBe('')
    })
  })
})
