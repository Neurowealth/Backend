/**
 * Contract tests for the idempotency middleware (#613).
 *
 * Each test here pins exactly one row in the "Behavioural guarantees" table in
 * docs/IDEMPOTENCY.md. If the test name no longer matches a row, update the
 * doc; if the behaviour changes, update both.
 */

import { idempotent } from '../../../src/middleware/idempotency'
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
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
  },
}))

type MockRedis = { get: jest.Mock; set: jest.Mock }

const KEY = 'contract-key'
const USER = 'user-contract'

function freshReq(
  overrides: Partial<Request & { header: jest.Mock }> = {}
): Partial<Request> {
  const base: Partial<Request> = {
    method: 'POST',
    path: '/deposit',
    body: { amount: 100, assetSymbol: 'USDC' },
    auth: {
      userId: USER,
      sessionId: 's1',
      walletAddress: 'G...',
      network: 'MAINNET',
    } as any,
    header: jest.fn((name: string) =>
      name === 'Idempotency-Key' ? KEY : undefined
    ) as any,
  }
  return { ...base, ...overrides }
}

function freshRes(): Partial<Response> {
  return {
    statusCode: 200,
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    setHeader: jest.fn(),
  }
}

describe('Idempotency consumer contract (docs/IDEMPOTENCY.md)', () => {
  let redis: MockRedis

  beforeEach(() => {
    jest.clearAllMocks()
    redis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
    }
    ;(getRedisClient as jest.Mock).mockReturnValue(redis)
    ;(db.idempotencyRecord.findUnique as jest.Mock).mockResolvedValue(null)
    ;(db.idempotencyRecord.upsert as jest.Mock).mockResolvedValue({})
  })

  it('first request, no key, non-required route: handler runs, nothing cached', async () => {
    const req = freshReq({
      header: jest.fn().mockReturnValue(undefined) as any,
    })
    const res = freshRes()
    const next = jest.fn() as NextFunction
    await idempotent({ required: false })(req as Request, res as Response, next)
    expect(next).toHaveBeenCalled()
    expect(redis.set).not.toHaveBeenCalled()
  })

  it('first request, no key, required route: 400 idempotency_key_required', async () => {
    const req = freshReq({
      header: jest.fn().mockReturnValue(undefined) as any,
    })
    const res = freshRes()
    const next = jest.fn() as NextFunction
    await idempotent({ required: true })(req as Request, res as Response, next)
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'idempotency_key_required' })
    expect(next).not.toHaveBeenCalled()
  })

  it('key > 255 chars: 400 idempotency_key_too_long', async () => {
    const req = freshReq({
      header: jest.fn((name: string) =>
        name === 'Idempotency-Key' ? 'a'.repeat(256) : undefined
      ) as any,
    })
    const res = freshRes()
    const next = jest.fn() as NextFunction
    await idempotent()(req as Request, res as Response, next)
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'idempotency_key_too_long' })
    expect(next).not.toHaveBeenCalled()
  })

  it('replay with identical fingerprint, cached 2xx: returns cached body with Idempotency-Replayed: true', async () => {
    const req = freshReq()
    const fingerprintReq = freshReq()
    // Prime: run once with the record store empty so the fingerprint is derived
    // from this request's canonical form, then stash the cached entry.
    const {
      computeFingerprint,
    } = require('../../../src/middleware/idempotency')
    const fingerprint = computeFingerprint(fingerprintReq as Request, USER)
    redis.get.mockResolvedValueOnce(
      JSON.stringify({
        fingerprint,
        status: 'completed',
        statusCode: 201,
        responseBody: { id: 'order-1' },
        completedAt: new Date().toISOString(),
      })
    )
    const res = freshRes()
    const next = jest.fn() as NextFunction
    await idempotent()(req as Request, res as Response, next)
    expect(res.setHeader).toHaveBeenCalledWith('Idempotency-Replayed', 'true')
    expect(res.status).toHaveBeenCalledWith(201)
    expect(res.json).toHaveBeenCalledWith({ id: 'order-1' })
    expect(next).not.toHaveBeenCalled()
  })

  it('replay with identical fingerprint, cached 4xx/5xx: returns cached error, no re-execution', async () => {
    const req = freshReq()
    const {
      computeFingerprint,
    } = require('../../../src/middleware/idempotency')
    const fingerprint = computeFingerprint(freshReq() as Request, USER)
    redis.get.mockResolvedValueOnce(
      JSON.stringify({
        fingerprint,
        status: 'completed',
        statusCode: 400,
        responseBody: { error: 'invalid_amount' },
        completedAt: new Date().toISOString(),
      })
    )
    const res = freshRes()
    const next = jest.fn() as NextFunction
    await idempotent()(req as Request, res as Response, next)
    expect(res.setHeader).toHaveBeenCalledWith('Idempotency-Replayed', 'true')
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'invalid_amount' })
    expect(next).not.toHaveBeenCalled()
  })

  it('same key, different body: 422 idempotency_key_reuse, no re-execution', async () => {
    const req = freshReq({ body: { amount: 500, assetSymbol: 'USDC' } }) // different amount
    redis.get.mockResolvedValueOnce(
      JSON.stringify({
        fingerprint: 'different-fingerprint-from-earlier-request',
        status: 'completed',
        statusCode: 200,
        responseBody: { id: 'earlier' },
      })
    )
    const res = freshRes()
    const next = jest.fn() as NextFunction
    await idempotent()(req as Request, res as Response, next)
    expect(res.status).toHaveBeenCalledWith(422)
    expect(res.json).toHaveBeenCalledWith({ error: 'idempotency_key_reuse' })
    expect(next).not.toHaveBeenCalled()
  })

  it('second request while first is in-flight: 409 idempotency_request_in_flight', async () => {
    const req = freshReq()
    const {
      computeFingerprint,
    } = require('../../../src/middleware/idempotency')
    const fingerprint = computeFingerprint(freshReq() as Request, USER)
    redis.get.mockResolvedValueOnce(
      JSON.stringify({ fingerprint, status: 'in_progress' })
    )
    const res = freshRes()
    const next = jest.fn() as NextFunction
    await idempotent()(req as Request, res as Response, next)
    expect(res.status).toHaveBeenCalledWith(409)
    expect(res.json).toHaveBeenCalledWith({
      error: 'idempotency_request_in_flight',
    })
    expect(next).not.toHaveBeenCalled()
  })

  it('replay after record TTL has elapsed: handler re-runs', async () => {
    const req = freshReq()
    // Redis returns nothing (TTL expired).
    redis.get.mockResolvedValue(null)
    // DB returns nothing (expiresAt filter in getDbRecord already returns null
    // for expired rows).
    ;(db.idempotencyRecord.findUnique as jest.Mock).mockResolvedValue(null)
    const res = freshRes()
    const next = jest.fn() as NextFunction
    await idempotent()(req as Request, res as Response, next)
    expect(next).toHaveBeenCalled()
  })

  it('required route with both stores down: 503', async () => {
    const req = freshReq()
    ;(getRedisClient as jest.Mock).mockReturnValue(null) // Redis unavailable
    ;(db.idempotencyRecord.findUnique as jest.Mock).mockRejectedValue(
      new Error('db unavailable')
    )
    const res = freshRes()
    const next = jest.fn() as NextFunction
    await idempotent({ required: true, failClosed: true })(
      req as Request,
      res as Response,
      next
    )
    expect(res.status).toHaveBeenCalledWith(503)
    expect(res.json).toHaveBeenCalledWith({
      error: 'Idempotency store unavailable',
    })
    expect(next).not.toHaveBeenCalled()
  })
})
