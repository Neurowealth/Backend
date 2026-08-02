import { Request, Response, NextFunction } from 'express'
import bcrypt from 'bcryptjs'
import db from '../../../src/db'
import { requireAdminAuth } from '../../../src/middleware/adminAuth'

jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: {},
}))

jest.mock('../../../src/utils/logger')

const mockBcryptCompare = jest.spyOn(bcrypt, 'compare')

describe('admin auth middleware', () => {
  let req: Partial<Request>
  let res: Partial<Response>
  let next: NextFunction

  beforeEach(() => {
    req = {
      headers: {},
      method: 'GET',
      path: '/api/admin/stellar/metrics',
      originalUrl: '/api/admin/stellar/metrics',
      ip: '203.0.113.10',
      get: jest.fn((name: string) => {
        if (name === 'user-agent') return 'jest-agent'
        return undefined
      }) as any,
    }

    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      locals: {},
    }

    next = jest.fn()
    jest.clearAllMocks()
    mockBcryptCompare.mockReset()
    mockBcryptCompare.mockResolvedValue(false as never)
  })

  it('rejects requests without any admin credentials', async () => {
    await requireAdminAuth(req as Request, res as Response, next)

    expect(res.status).toHaveBeenCalledWith(401)
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: 'Admin authentication required',
    })
    expect(next).not.toHaveBeenCalled()
  })

  it('accepts a valid bearer token that matches a hashed stored admin token', async () => {
    req.headers = { authorization: 'Bearer valid-admin-token' }

    ;(db as any).adminApiKey = {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'token-1',
          name: 'ops-token',
          role: 'OPS_ADMIN',
          scopes: ['metrics:read'],
          hash: '$2a$12$fakehash',
        },
      ]),
      update: jest.fn().mockResolvedValue({}),
    }
    mockBcryptCompare.mockResolvedValue(true as never)

    await requireAdminAuth(req as Request, res as Response, next)

    expect((db as any).adminApiKey.findMany).toHaveBeenCalled()
    expect(mockBcryptCompare).toHaveBeenCalledWith(
      'valid-admin-token',
      '$2a$12$fakehash'
    )
    expect(res.status).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalled()
    expect(res.locals?.adminAuth).toEqual(
      expect.objectContaining({
        id: 'token-1',
        name: 'ops-token',
        role: 'OPS_ADMIN',
        scopes: ['metrics:read'],
      })
    )
  })

  it('updates lastUsedAt after a successful authentication', async () => {
    req.headers = { authorization: 'Bearer valid-admin-token' }

    const mockUpdate = jest.fn().mockResolvedValue({})
    ;(db as any).adminApiKey = {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'token-1',
          name: 'ops-token',
          role: 'OPS_ADMIN',
          scopes: ['metrics:read'],
          hash: '$2a$12$fakehash',
        },
      ]),
      update: mockUpdate,
    }
    mockBcryptCompare.mockResolvedValue(true as never)

    await requireAdminAuth(req as Request, res as Response, next)

    // Give the fire-and-forget update a tick to run
    await new Promise((resolve) => setImmediate(resolve))

    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'token-1' },
        data: expect.objectContaining({ lastUsedAt: expect.any(Date) }),
      })
    )
  })

  it('rejects a token when the DB query returns no candidates (revoked/expired filtered at DB level)', async () => {
    req.headers = { authorization: 'Bearer revoked-or-expired-token' }

    // The real WHERE clause filters revokedAt IS NULL and expiresAt > now,
    // so revoked/expired rows are never returned to the application layer.
    // This test asserts that behaviour: findMany returns [] and auth is denied.
    ;(db as any).adminApiKey = {
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
    }

    await requireAdminAuth(req as Request, res as Response, next)

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: 'Admin access revoked or expired',
    })
    expect(next).not.toHaveBeenCalled()
    // bcrypt should never be called when there are no candidates
    expect(mockBcryptCompare).not.toHaveBeenCalled()
  })

  it('rejects a valid-format token that does not match any stored hash', async () => {
    req.headers = { authorization: 'Bearer unknown-token' }

    ;(db as any).adminApiKey = {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'token-3',
          name: 'some-token',
          role: 'OPS_ADMIN',
          scopes: ['metrics:read'],
          hash: '$2a$12$fakehash',
        },
      ]),
      update: jest.fn(),
    }
    // bcrypt returns false — token doesn't match the hash
    mockBcryptCompare.mockResolvedValue(false as never)

    await requireAdminAuth(req as Request, res as Response, next)

    expect(res.status).toHaveBeenCalledWith(403)
    expect(next).not.toHaveBeenCalled()
  })

  it('accepts the legacy X-Admin-Token header', async () => {
    req.headers = { 'x-admin-token': 'legacy-token' }

    ;(db as any).adminApiKey = {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'token-4',
          name: 'legacy',
          role: 'OPS_ADMIN',
          scopes: ['dlq:read'],
          hash: '$2a$12$fakehash',
        },
      ]),
      update: jest.fn().mockResolvedValue({}),
    }
    mockBcryptCompare.mockResolvedValue(true as never)

    await requireAdminAuth(req as Request, res as Response, next)

    expect(mockBcryptCompare).toHaveBeenCalledWith(
      'legacy-token',
      '$2a$12$fakehash'
    )
    expect(next).toHaveBeenCalled()
  })

  it('returns 500 when the database throws', async () => {
    req.headers = { authorization: 'Bearer any-token' }

    ;(db as any).adminApiKey = {
      findMany: jest.fn().mockRejectedValue(new Error('DB connection lost')),
    }

    await requireAdminAuth(req as Request, res as Response, next)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: 'Internal server error',
    })
    expect(next).not.toHaveBeenCalled()
  })
})
