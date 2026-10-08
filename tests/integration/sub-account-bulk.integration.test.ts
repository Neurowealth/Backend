const mockParentUserId = '11111111-1111-4111-8111-111111111111'
const mockChildUserId1 = '22222222-2222-4222-8222-222222222222'
const mockChildUserId2 = '33333333-3333-4333-8333-333333333333'
const mockOtherChildUserId = '44444444-4444-4444-8444-444444444444'

import request from 'supertest'
import express from 'express'
import db from '../../src/db'
import { logger } from '../../src/utils/logger'

jest.mock('../../src/middleware/authenticate', () => {
  const requireAuth = jest.fn((req: any, _res: any, next: any) => {
    req.userId = mockParentUserId
    req.auth = {
      userId: mockParentUserId,
      walletAddress: 'GPARENT_WALLET',
      network: 'TESTNET',
    }
    next()
  })
  return { requireAuth }
})

jest.mock('../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}))

const subAccounts = new Map<string, any>()
let subSeq = 0

jest.mock('../../src/db', () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(async (cb: any) => {
      const snapshot = structuredClone(subAccounts)
      const tx = {
        user: {
          findUnique: jest.fn(async ({ where }: any) => {
            if (
              where.id === mockChildUserId1 ||
              where.id === mockChildUserId2 ||
              where.id === mockOtherChildUserId
            ) {
              return { id: where.id }
            }
            return null
          }),
        },
        subAccount: {
          findFirst: jest.fn(async () => null),
          findUnique: jest.fn(async ({ where }: any) => {
            if (where.id) return subAccounts.get(where.id) ?? null
            if (where.parentUserId_childUserId) {
              const key = `${where.parentUserId_childUserId.parentUserId}:${where.parentUserId_childUserId.childUserId}`
              return subAccounts.get(key) ?? null
            }
            return null
          }),
          create: jest.fn(async ({ data }: any) => {
            const id = `sub-${++subSeq}`
            const key = `${data.parentUserId}:${data.childUserId}`
            const record = { ...data, id, status: 'ACTIVE' }
            subAccounts.set(id, record)
            subAccounts.set(key, record)
            return record
          }),
          update: jest.fn(async ({ where, data }: any) => {
            const record = subAccounts.get(where.id)
            if (!record) throw new Error('Sub-account not found')
            Object.assign(record, data)
            return record
          }),
        },
      }
      try {
        return await cb(tx)
      } catch (error) {
        subAccounts.clear()
        for (const [key, value] of snapshot) subAccounts.set(key, value)
        throw error
      }
    }),
    user: {
      findUnique: jest.fn(async ({ where }: any) => {
        if (
          where.id === mockChildUserId1 ||
          where.id === mockChildUserId2 ||
          where.id === mockOtherChildUserId
        ) {
          return { id: where.id }
        }
        return null
      }),
    },
    subAccount: {
      findMany: jest.fn(async ({ where }: any) => {
        const result: any[] = []
        for (const s of subAccounts.values()) {
          if (s.parentUserId === where.parentUserId) {
            if (!result.some((r) => r.id === s.id)) result.push(s)
          }
        }
        return result
      }),
      findFirst: jest.fn(async () => null),
      findUnique: jest.fn(async ({ where }: any) => {
        if (where.id) return subAccounts.get(where.id) ?? null
        if (where.parentUserId_childUserId) {
          const key = `${where.parentUserId_childUserId.parentUserId}:${where.parentUserId_childUserId.childUserId}`
          return subAccounts.get(key) ?? null
        }
        return null
      }),
      create: jest.fn(async ({ data }: any) => {
        const id = `sub-${++subSeq}`
        const key = `${data.parentUserId}:${data.childUserId}`
        const record = { ...data, id, status: 'ACTIVE' }
        subAccounts.set(id, record)
        subAccounts.set(key, record)
        return record
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const record = subAccounts.get(where.id)
        if (!record) throw new Error('Sub-account not found')
        Object.assign(record, data)
        return record
      }),
    },
    transaction: {
      count: jest.fn(async () => 5),
    },
  },
}))

import subAccountRouter from '../../src/routes/sub-accounts'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1/sub-accounts', subAccountRouter)
  return app
}

describe('Sub-Account Bulk Operations & Summary Integration Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    subAccounts.clear()
    subSeq = 0
  })

  it('validates malformed rows independently and preserves deterministic order', async () => {
    const app = buildApp()
    const response = await request(app)
      .post('/api/v1/sub-accounts/bulk')
      .send({
        operations: [
          {
            action: 'create',
            childUserId: mockChildUserId1,
            payload: { permissions: ['VIEW'] },
          },
          {
            action: 'setPermission',
            childUserId: mockChildUserId1,
            payload: { permissions: [] },
          },
          {
            action: 'setPermission',
            childUserId: mockChildUserId1,
            payload: { permissions: ['DEPOSIT'] },
          },
          {
            action: 'setLimit',
            childUserId: mockChildUserId1,
            payload: { dailyLimit: 123 },
          },
        ],
      })
    expect(response.status).toBe(200)
    expect(response.body.results.map((r: any) => r.success)).toEqual([
      true,
      false,
      true,
      true,
    ])
    const stored = subAccounts.get(`${mockParentUserId}:${mockChildUserId1}`)
    expect(stored.permissions).toEqual(['DEPOSIT'])
    expect(stored.dailyLimit).toBe(123)
    expect(logger.info).toHaveBeenCalledTimes(3)
  })

  it('rolls back all atomic mutations and identifies the failing operation', async () => {
    const response = await request(buildApp())
      .post('/api/v1/sub-accounts/bulk')
      .send({
        atomic: true,
        operations: [
          {
            action: 'create',
            childUserId: mockChildUserId1,
            payload: { permissions: ['VIEW'] },
          },
          {
            action: 'setPermission',
            childUserId: mockChildUserId1,
            payload: { permissions: [] },
          },
        ],
      })
    expect(response.status).toBe(400)
    expect(response.body.rolledBack).toBe(true)
    expect(response.body.failedIndex).toBe(1)
    expect(response.body.results[0].rolledBack).toBe(true)
    expect(subAccounts.size).toBe(0)
    expect(logger.info).not.toHaveBeenCalled()
  })

  it('uses the same forbidden response for foreign children as single calls', async () => {
    const foreignId = '55555555-5555-4555-8555-555555555555'
    subAccounts.set(foreignId, {
      id: foreignId,
      parentUserId: 'another-parent',
      childUserId: mockOtherChildUserId,
      permissions: ['VIEW'],
      status: 'ACTIVE',
    })
    const response = await request(buildApp())
      .post('/api/v1/sub-accounts/bulk')
      .send({
        operations: [
          {
            action: 'setLimit',
            subAccountId: foreignId,
            payload: { dailyLimit: 1 },
          },
        ],
      })
    expect(response.body.results[0]).toMatchObject({
      success: false,
      status: 403,
      error: 'Forbidden',
    })
    expect(subAccounts.get(foreignId).dailyLimit).toBeUndefined()
  })

  it('rejects duplicate active creations rather than silently changing permissions', async () => {
    const response = await request(buildApp())
      .post('/api/v1/sub-accounts/bulk')
      .send({
        operations: [
          {
            action: 'create',
            childUserId: mockChildUserId1,
            payload: { permissions: ['VIEW'] },
          },
          {
            action: 'create',
            childUserId: mockChildUserId1,
            payload: { permissions: ['WITHDRAW'] },
          },
        ],
      })
    expect(response.body.results[1]).toMatchObject({
      success: false,
      status: 409,
    })
    expect(
      subAccounts.get(`${mockParentUserId}:${mockChildUserId1}`).permissions
    ).toEqual(['VIEW'])
  })

  it('POST /api/v1/sub-accounts/bulk processes non-atomic batch with partial failures', async () => {
    const app = buildApp()

    const res = await request(app)
      .post('/api/v1/sub-accounts/bulk')
      .send({
        atomic: false,
        operations: [
          {
            action: 'create',
            childUserId: mockChildUserId1,
            payload: { permissions: ['VIEW', 'DEPOSIT'] },
          },
          {
            action: 'create',
            childUserId: '00000000-0000-0000-0000-000000000000', // Non-existent child
            payload: { permissions: ['VIEW'] },
          },
        ],
      })

    expect(res.status).toBe(200)
    expect(res.body.atomic).toBe(false)
    expect(res.body.results).toHaveLength(2)
    expect(res.body.results[0].success).toBe(true)
    expect(res.body.results[1].success).toBe(false)
  })

  it('POST /api/v1/sub-accounts/bulk rejects batch exceeding limit upfront', async () => {
    const app = buildApp()

    const operations = Array.from({ length: 101 }, (_, i) => ({
      action: 'create',
      childUserId: mockChildUserId1,
    }))

    const res = await request(app)
      .post('/api/v1/sub-accounts/bulk')
      .send({ operations })

    expect(res.status).toBe(400)
    expect(res.body.error).toContain('Batch size exceeds maximum limit')
    expect(db.subAccount.create).not.toHaveBeenCalled()
    expect(db.$transaction).not.toHaveBeenCalled()
  })

  it('GET /api/v1/sub-accounts/summary returns aggregate statistics', async () => {
    const app = buildApp()

    // First create a sub-account
    await request(app)
      .post('/api/v1/sub-accounts/bulk')
      .send({
        operations: [
          {
            action: 'create',
            childUserId: mockChildUserId1,
            payload: {
              permissions: ['VIEW', 'WITHDRAW'],
              dailyLimit: 250,
            },
          },
        ],
      })

    const summaryRes = await request(app).get('/api/v1/sub-accounts/summary')

    expect(summaryRes.status).toBe(200)
    expect(summaryRes.body.summary).toBeDefined()
    expect(summaryRes.body.summary.totalChildren).toBe(1)
    expect(summaryRes.body.summary.totalDailyLimitExposure).toBe(250)
  })
})
