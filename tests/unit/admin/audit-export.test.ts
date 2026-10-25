process.env.NODE_ENV = 'test'

import { Request, Response, NextFunction } from 'express'
import adminRouter from '../../../src/routes/admin'

const mockCount = jest.fn()
const mockFindMany = jest.fn()
const mockCreate = jest.fn().mockResolvedValue({})

jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: {
    adminAuditLog: {
      count: (...args: unknown[]) => mockCount(...args),
      findMany: (...args: unknown[]) => mockFindMany(...args),
      create: (...args: unknown[]) => mockCreate(...args),
    },
    auditBlock: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    $queryRaw: jest
      .fn()
      .mockResolvedValue([{ legalHold: false, retentionDays: 365 }]),
    adminApiKey: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  },
}))

jest.mock('../../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}))

describe('GET /api/admin/audit/export (#682)', () => {
  let req: Partial<Request>
  let res: Partial<Response>
  let next: jest.Mock
  let scopeMiddleware: (
    req: Request,
    res: Response,
    next: NextFunction
  ) => Promise<void>
  let exportHandler: (req: Request, res: Response) => Promise<Response | void>

  beforeAll(() => {
    // Find the /audit/export route layer from the router stack
    const layer = adminRouter.stack.find(
      (l: any) => l.route?.path === '/audit/export'
    )
    if (!layer || !layer.route) {
      throw new Error('/audit/export route not found on adminRouter')
    }
    // layer.route.stack[0] is requireAdminScope('read')
    // layer.route.stack[1] is the export controller
    scopeMiddleware = layer.route.stack[0].handle
    exportHandler = layer.route.stack[1]
      .handle as unknown as typeof exportHandler
  })

  beforeEach(() => {
    jest.clearAllMocks()
    req = {
      path: '/audit/export',
      originalUrl: '/api/admin/audit/export',
      method: 'GET',
      ip: '127.0.0.1',
      headers: {},
      query: {},
      get: jest.fn().mockReturnValue('JestTest'),
    }
    res = {
      locals: {},
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis(),
      setHeader: jest.fn().mockReturnThis(),
    }
    next = jest.fn()
  })

  it('rejects unauthenticated requests with 401 via scope guard', async () => {
    res.locals = {}
    await scopeMiddleware(req as Request, res as Response, next)

    expect(res.status).toHaveBeenCalledWith(401)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Admin authentication required' })
    )
    expect(next).not.toHaveBeenCalled()
  })

  it('rejects requests lacking read scope with 403 via scope guard', async () => {
    res.locals = {
      adminAuth: {
        id: 'admin-key-1',
        name: 'Restricted Key',
        role: 'operator',
        scopes: ['metrics:read'], // Missing 'read' or 'super'
      },
    }

    await scopeMiddleware(req as Request, res as Response, next)

    expect(res.status).toHaveBeenCalledWith(403)
    expect(next).not.toHaveBeenCalled()
  })

  it('allows access through scope guard when admin has read scope', async () => {
    res.locals = {
      adminAuth: {
        id: 'admin-key-1',
        name: 'Compliance Admin',
        role: 'admin',
        scopes: ['read'],
      },
    }

    await scopeMiddleware(req as Request, res as Response, next)
    expect(next).toHaveBeenCalled()
  })

  it('allows access through scope guard when admin has super scope', async () => {
    res.locals = {
      adminAuth: {
        id: 'admin-key-super',
        name: 'Super Admin',
        role: 'super',
        scopes: ['super'],
      },
    }

    await scopeMiddleware(req as Request, res as Response, next)
    expect(next).toHaveBeenCalled()
  })

  it('returns paginated audit logs for authorized admin and audits the call', async () => {
    res.locals = {
      adminAuth: {
        id: 'admin-key-1',
        name: 'Compliance Officer',
        role: 'admin',
        scopes: ['read'],
      },
    }

    const sampleLogs = [
      {
        id: 'log-1',
        adminKeyId: 'admin-key-1',
        adminName: 'Compliance Officer',
        adminRole: 'admin',
        action: 'DLQ_INSPECT',
        target: '/api/admin/dlq',
        result: 'success',
        details: { count: 5 },
        ipAddress: '127.0.0.1',
        userAgent: 'JestTest',
        method: 'GET',
        path: '/api/admin/dlq',
        createdAt: new Date('2026-10-20T10:00:00Z'),
      },
    ]

    mockCount.mockResolvedValue(1)
    mockFindMany.mockResolvedValue(sampleLogs)
    req.query = { page: '1', limit: '10' }

    await exportHandler(req as Request, res as Response)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: sampleLogs,
        pagination: expect.objectContaining({
          page: 1,
          limit: 10,
          total: 1,
          totalPages: 1,
          hasNext: false,
          hasPrevious: false,
        }),
        exportMeta: expect.objectContaining({
          exportedBy: 'admin-key-1',
          legalHoldActive: false,
          retentionPeriodDays: 365,
        }),
      })
    )

    // Self-audit: record this export operation in AdminAuditLog
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'EXPORT_ADMIN_AUDIT_LOGS',
          result: 'success',
          adminKeyId: 'admin-key-1',
        }),
      })
    )
  })

  it('filters by date range, action, adminKeyId, and result status', async () => {
    res.locals = {
      adminAuth: {
        id: 'admin-key-1',
        name: 'Super Admin',
        role: 'super',
        scopes: ['super'],
      },
    }

    mockCount.mockResolvedValue(0)
    mockFindMany.mockResolvedValue([])

    req.query = {
      from: '2026-10-01T00:00:00Z',
      to: '2026-10-20T00:00:00Z',
      action: 'CREATE_ADMIN_KEY',
      adminKeyId: 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d',
      result: 'success',
    }

    await exportHandler(req as Request, res as Response)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: {
            gte: new Date('2026-10-01T00:00:00Z'),
            lte: new Date('2026-10-20T00:00:00Z'),
          },
          action: 'CREATE_ADMIN_KEY',
          adminKeyId: 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d',
          result: 'success',
        }),
      })
    )
  })

  it('rejects malformed date filter with 400 Bad Request', async () => {
    res.locals = {
      adminAuth: {
        id: 'admin-key-1',
        name: 'Admin',
        role: 'admin',
        scopes: ['read'],
      },
    }

    req.query = { from: 'not-a-valid-date' }

    await exportHandler(req as Request, res as Response)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: 'Invalid admin audit export query parameters',
      })
    )
  })

  it('exports CSV formatted records when requested with format=csv', async () => {
    res.locals = {
      adminAuth: {
        id: 'admin-key-1',
        name: 'Admin',
        role: 'admin',
        scopes: ['read'],
      },
    }

    const sampleLogs = [
      {
        id: 'log-101',
        adminKeyId: 'key-1',
        adminName: 'Audit, User',
        adminRole: 'admin',
        action: 'EMERGENCY_SWEEP',
        target: '/api/admin/treasury',
        result: 'success',
        details: { amount: 100 },
        ipAddress: '10.0.0.1',
        userAgent: 'curl/7.68.0\nInjected line',
        method: 'POST',
        path: '/api/admin/treasury',
        createdAt: new Date('2026-10-21T12:00:00Z'),
      },
    ]

    mockCount.mockResolvedValue(1)
    mockFindMany.mockResolvedValue(sampleLogs)
    req.query = { format: 'csv' }

    await exportHandler(req as Request, res as Response)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'text/csv; charset=utf-8'
    )
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      expect.stringContaining('attachment; filename="admin-audit-export-')
    )
    expect(res.send).toHaveBeenCalledWith(
      expect.stringContaining('id,adminKeyId,adminName,adminRole,action')
    )
    expect(res.send).toHaveBeenCalledWith(
      expect.stringContaining('"Audit, User"')
    )
    expect(res.send).toHaveBeenCalledWith(
      expect.stringContaining('EMERGENCY_SWEEP')
    )
    const csv = (res.send as jest.Mock).mock.calls[0][0] as string
    expect(csv).toContain('\r\n')
    expect(csv.split('\r\n').join('')).not.toContain('\n')
    expect(csv).toContain('"curl/7.68.0\r\nInjected line"')
  })

  it.each([
    [{ format: 'xml' }],
    [{ result: 'denied' }],
    [{ adminKeyId: 'not-a-uuid' }],
    [{ page: '2abc' }],
  ])('rejects invalid export query %j', async (query) => {
    res.locals = {
      adminAuth: {
        id: 'admin-key-1',
        name: 'Admin',
        role: 'admin',
        scopes: ['read'],
      },
    }
    req.query = query

    await exportHandler(req as Request, res as Response)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(mockFindMany).not.toHaveBeenCalled()
  })
})
