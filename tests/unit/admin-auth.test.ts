process.env.NODE_ENV = 'test'

import { Request, Response, NextFunction } from 'express'
import {
  requireAdminScope,
  validateScopesInput,
  AdminScope,
  AdminAuthContext,
} from '../../src/middleware/adminAuth'
import db from '../../src/db'

jest.mock('../../src/db', () => ({
  __esModule: true,
  default: {
    adminAuditLog: {
      create: jest.fn().mockResolvedValue({}),
    },
  },
}))

jest.mock('../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

describe('Admin Auth & Scope Boundary Hardening (#517)', () => {
  let req: Partial<Request>
  let res: Partial<Response>
  let next: jest.Mock

  beforeEach(() => {
    jest.clearAllMocks()
    req = {
      path: '/api/admin/test',
      originalUrl: '/api/admin/test',
      method: 'GET',
      ip: '127.0.0.1',
      headers: {},
    }
    res = {
      locals: {},
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    }
    next = jest.fn()
  })

  describe('requireAdminScope Guard', () => {
    it('returns 401 when res.locals.adminAuth is missing', async () => {
      const middleware = requireAdminScope('keys:read')
      await middleware(req as Request, res as Response, next)

      expect(res.status).toHaveBeenCalledWith(401)
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'Admin authentication required' })
      )
      expect(next).not.toHaveBeenCalled()
    })

    it.each([
      null,
      {},
      { scopes: ['super'] },
      { id: 'key', name: 'name', role: 'admin', scopes: 'super' },
      { id: 'key', name: 'name', role: 'admin', scopes: null },
      { id: 'key', name: 'name', role: 'admin', scopes: [123] },
      { id: '', name: 'name', role: 'admin', scopes: ['super'] },
      { id: 'key', name: 'name', role: 'admin', scopes: ['unknown'] },
    ])('rejects malformed auth context %j with 401', async (auth) => {
      res.locals!.adminAuth = auth
      await requireAdminScope('keys:write')(
        req as Request,
        res as Response,
        next
      )
      expect(res.status).toHaveBeenCalledWith(401)
      expect(next).not.toHaveBeenCalled()
    })

    it.each([
      ['sessions:read', 'read'],
      ['sessions:write', 'write'],
      ['agent:read', 'read'],
      ['agent:write', 'write'],
      ['reserves:read', 'read'],
      ['keys:write', 'write'],
      ['treasury:write', 'write'],
      ['agent:write', 'agent:read'],
      ['sessions:read', 'agent'],
    ])('denies %s to a key with only %s', async (required, granted) => {
      res.locals!.adminAuth = {
        id: 'key',
        name: 'name',
        role: 'admin',
        scopes: [granted],
      }
      await requireAdminScope(required as AdminScope)(
        req as Request,
        res as Response,
        next
      )
      expect(res.status).toHaveBeenCalledWith(403)
      expect(next).not.toHaveBeenCalled()
      expect(db.adminAuditLog.create).toHaveBeenCalled()
    })

    it.each([
      ['sessions:read', 'sessions:read'],
      ['sessions:write', 'sessions:write'],
      ['reserves:read', 'reserves:read'],
      ['agent:read', 'agent:read'],
      ['agent:write', 'agent:write'],
      ['agent:write', 'agent'],
    ])('allows %s with %s', async (required, granted) => {
      res.locals!.adminAuth = {
        id: 'key',
        name: 'name',
        role: 'admin',
        scopes: [granted],
      }
      await requireAdminScope(required as AdminScope)(
        req as Request,
        res as Response,
        next
      )
      expect(next).toHaveBeenCalled()
      expect(res.status).not.toHaveBeenCalled()
    })

    it('still denies access when audit persistence fails', async () => {
      jest
        .mocked(db.adminAuditLog.create)
        .mockRejectedValueOnce(new Error('DB unavailable'))
      res.locals!.adminAuth = {
        id: 'key',
        name: 'name',
        role: 'admin',
        scopes: [],
      }
      await requireAdminScope('keys:write')(
        req as Request,
        res as Response,
        next
      )
      expect(res.status).toHaveBeenCalledWith(403)
      expect(next).not.toHaveBeenCalled()
    })

    it('returns 403 and logs audit entry when scope is missing', async () => {
      res.locals!.adminAuth = {
        id: 'key-1',
        name: 'test-key',
        role: 'operator',
        scopes: ['metrics:read'],
      } as AdminAuthContext

      const middleware = requireAdminScope('keys:write')
      await middleware(req as Request, res as Response, next)

      expect(res.status).toHaveBeenCalledWith(403)
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "Admin scope 'keys:write' required",
        })
      )
      expect(db.adminAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            adminKeyId: 'key-1',
            action: 'scope_check',
            result: 'denied',
          }),
        })
      )
      expect(next).not.toHaveBeenCalled()
    })

    it('allows request when exact scope is present', async () => {
      res.locals!.adminAuth = {
        id: 'key-1',
        name: 'test-key',
        role: 'operator',
        scopes: ['keys:write'],
      } as AdminAuthContext

      const middleware = requireAdminScope('keys:write')
      await middleware(req as Request, res as Response, next)

      expect(next).toHaveBeenCalled()
      expect(res.status).not.toHaveBeenCalled()
    })

    it('allows request when super scope is present', async () => {
      res.locals!.adminAuth = {
        id: 'key-super',
        name: 'super-key',
        role: 'admin',
        scopes: ['super'],
      } as AdminAuthContext

      const middleware = requireAdminScope('treasury:write')
      await middleware(req as Request, res as Response, next)

      expect(next).toHaveBeenCalled()
      expect(res.status).not.toHaveBeenCalled()
    })

    it('allows request when domain scope (e.g. agent) satisfies sub-scope (e.g. agent:read)', async () => {
      res.locals!.adminAuth = {
        id: 'key-agent',
        name: 'agent-key',
        role: 'operator',
        scopes: ['agent'],
      } as AdminAuthContext

      const middleware = requireAdminScope('agent:read')
      await middleware(req as Request, res as Response, next)

      expect(next).toHaveBeenCalled()
      expect(res.status).not.toHaveBeenCalled()
    })
  })

  describe('validateScopesInput', () => {
    it('returns true for valid scopes', () => {
      expect(validateScopesInput(['read', 'keys:write', 'super'])).toBe(true)
    })

    it('returns false for invalid scopes or empty array', () => {
      expect(validateScopesInput([])).toBe(false)
      expect(validateScopesInput(['invalid:scope'])).toBe(false)
      expect(validateScopesInput(null)).toBe(false)
    })
  })
})
