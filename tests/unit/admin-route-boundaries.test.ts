import type { Request, Response } from 'express'
import router from '../../src/routes/admin'
import db from '../../src/db'

jest.mock('../../src/db', () => ({
  __esModule: true,
  default: {
    adminApiKey: { create: jest.fn().mockResolvedValue({ id: 'created' }) },
    adminAuditLog: { create: jest.fn().mockResolvedValue({}) },
  },
}))
jest.mock('../../src/stellar/events', () => ({}))
jest.mock('../../src/stellar/dlq', () => ({}))
jest.mock('../../src/fiat/registry', () => ({}))
jest.mock('../../src/services/refresh-token.service', () => ({}))
jest.mock('../../src/services/alerting', () => ({}))
jest.mock('../../src/audit/chain', () => ({}))
jest.mock('../../src/agent/breakerService', () => ({}))
jest.mock('../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))
jest.mock('bcryptjs', () => ({ hash: jest.fn().mockResolvedValue('hash') }))

const routes = router.stack
  .filter((layer: any) => layer.route)
  .map((layer: any) => layer.route)

function response(scopes?: string[]) {
  return {
    locals: scopes
      ? { adminAuth: { id: 'key', name: 'operator', role: 'admin', scopes } }
      : {},
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response
}

const req = {
  body: { name: 'new-key', role: 'admin', scopes: ['super'] },
  headers: {},
  get: jest.fn(),
  method: 'POST',
  originalUrl: '/api/admin/keys',
} as unknown as Request

describe('admin route boundaries', () => {
  it.each(routes.map((route: any) => [route.path, route]))(
    '%s handler fails closed without identity',
    async (_path, route) => {
      const res = response()
      await route.stack[route.stack.length - 1].handle({} as Request, res)
      expect(res.status).toHaveBeenCalledWith(401)
      expect(db.adminApiKey.create).not.toHaveBeenCalled()
    }
  )

  it.each([
    [['keys:write'], ['super'], 403],
    [['keys:write'], ['treasury:write'], 403],
    [['super'], ['not-a-scope'], 400],
    [['super'], [], 400],
    [['keys:write'], ['keys:write'], 201],
    [['keys:write', 'agent'], ['agent:read', 'agent:write'], 201],
    [['super'], ['super'], 201],
  ])(
    'key scopes %j requesting %j returns %s',
    async (granted, requested, status) => {
      const route = routes.find(
        (route: any) => route.path === '/keys' && route.methods.post
      )
      const res = response(granted as string[])
      await route.stack[route.stack.length - 1].handle(
        { ...req, body: { ...req.body, scopes: requested } },
        res
      )
      expect(res.status).toHaveBeenCalledWith(status)
      if (status === 201) expect(db.adminApiKey.create).toHaveBeenCalled()
      else expect(db.adminApiKey.create).not.toHaveBeenCalled()
    }
  )
})
