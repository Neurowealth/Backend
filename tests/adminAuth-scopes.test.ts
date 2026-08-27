// src/__tests__/adminAuth-scopes.test.ts
// #215 – unit tests for each scope boundary
import {
  validateScopesInput,
  ADMIN_SCOPES,
  AdminScope,
} from '../src/middleware/adminAuth'
import type { Request, Response, NextFunction } from 'express'

// ── validateScopesInput ────────────────────────────────────────────────────

describe('validateScopesInput', () => {
  test('accepts all known scopes individually', () => {
    for (const scope of ADMIN_SCOPES) {
      expect(validateScopesInput([scope])).toBe(true)
    }
  })

  test('accepts a valid combination', () => {
    expect(validateScopesInput(['read', 'write'])).toBe(true)
  })

  test('rejects empty array', () => {
    expect(validateScopesInput([])).toBe(false)
  })

  test('rejects unknown scope', () => {
    expect(validateScopesInput(['admin', 'root'])).toBe(false)
  })

  test('rejects non-array', () => {
    expect(validateScopesInput('read')).toBe(false)
    expect(validateScopesInput(null)).toBe(false)
  })
})

// ── requireAdminScope middleware logic ─────────────────────────────────────

function makeRes(scopes: AdminScope[]) {
  const locals: any = {
    adminAuth: { id: 'key-1', name: 'test-key', role: 'admin', scopes },
  }
  const res: any = {
    locals,
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  }
  return res as Response
}

function makeReq(): Request {
  return {
    ip: '127.0.0.1',
    headers: {},
    originalUrl: '/admin/test',
    method: 'GET',
  } as any
}

// We test the logic directly by importing the factory
import { requireAdminScope } from '../src/middleware/adminAuth'

describe('requireAdminScope middleware', () => {
  const next: NextFunction = jest.fn()

  beforeEach(() => jest.clearAllMocks())

  test('allows request when scope matches', async () => {
    const mw = requireAdminScope('read')
    const req = makeReq()
    const res = makeRes(['read'])
    await mw(req, res, next)
    expect(next).toHaveBeenCalled()
    expect(res.status).not.toHaveBeenCalled()
  })

  test('allows request when key has super scope', async () => {
    const mw = requireAdminScope('wallet')
    const req = makeReq()
    const res = makeRes(['super'])
    await mw(req, res, next)
    expect(next).toHaveBeenCalled()
  })

  test('blocks request and returns 403 when scope missing', async () => {
    const mw = requireAdminScope('write')
    const req = makeReq()
    const res = makeRes(['read'])
    await mw(req, res, next)
    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: "Admin scope 'write' required",
      })
    )
  })

  test('returns 401 when adminAuth context is missing', async () => {
    const mw = requireAdminScope('read')
    const req = makeReq()
    const res: any = {
      locals: {},
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    }
    await mw(req, res, next)
    expect(res.status).toHaveBeenCalledWith(401)
  })

  test.each([
    ['read', ['read'], true],
    ['write', ['read'], false],
    ['wallet', ['read', 'write'], false],
    ['agent', ['agent'], true],
    ['super', ['super'], true],
    ['wallet', ['read', 'wallet'], true],
    ['agent', ['super'], true],
    ['write', ['super'], true],
  ])(
    'scope=%s, grantedScopes=%j → allowed=%s',
    async (required, granted, allowed) => {
      const mw = requireAdminScope(required as AdminScope)
      const req = makeReq()
      const res = makeRes(granted as AdminScope[])
      await mw(req, res, next)
      if (allowed) {
        expect(next).toHaveBeenCalled()
      } else {
        expect(res.status).toHaveBeenCalledWith(403)
      }
      jest.clearAllMocks()
    }
  )
})
