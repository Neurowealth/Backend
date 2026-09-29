const mockUserId = '11111111-1111-4111-8111-111111111111'
const otherUserId = '22222222-2222-4222-8222-222222222222'

import request from 'supertest'
import express from 'express'

jest.mock('../../src/middleware/authenticate', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.userId = mockUserId
    req.auth = { userId: mockUserId, walletAddress: 'GWALLET_USER_1' }
    next()
  },
  enforceUserAccess: (req: any, res: any, next: any) => {
    const targetUserId = req.params.userId ?? req.body?.userId
    if (targetUserId && req.auth.userId !== targetUserId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    next()
  },
}))

jest.mock('../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}))

jest.mock('../../src/db', () => ({
  __esModule: true,
  default: {
    user: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    position: {
      findMany: jest.fn(),
    },
  },
}))

import db from '../../src/db'
import liquidityFloorRouter from '../../src/routes/liquidity-floor'

const mockDb = db as any

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1/liquidity-floor', liquidityFloorRouter)
  return app
}

const app = buildApp()

describe('Liquidity Floor API Integration (#541)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('GET /api/v1/liquidity-floor', () => {
    it('returns standing liquidity floor metrics for caller', async () => {
      mockDb.user.findUnique.mockResolvedValueOnce({
        id: mockUserId,
        liquidityFloor: '1000',
        strategyConfig: {},
      })

      mockDb.position.findMany.mockResolvedValueOnce([
        {
          id: 'pos-1',
          protocolName: 'Cash',
          assetSymbol: 'USDC',
          currentValue: '1500',
          status: 'ACTIVE',
        },
      ])

      const res = await request(app).get('/api/v1/liquidity-floor')

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data.userId).toBe(mockUserId)
      expect(res.body.data.floor).toBe('1000')
      expect(res.body.data.isSatisfied).toBe(true)
      expect(res.body.data.status).toBe('SATISFIED')
    })

    it('returns degraded status when floor exceeds balance', async () => {
      mockDb.user.findUnique.mockResolvedValueOnce({
        id: mockUserId,
        liquidityFloor: '2000',
        strategyConfig: {},
      })

      mockDb.position.findMany.mockResolvedValueOnce([
        {
          id: 'pos-1',
          protocolName: 'Cash',
          assetSymbol: 'USDC',
          currentValue: '500',
          status: 'ACTIVE',
        },
      ])

      const res = await request(app).get('/api/v1/liquidity-floor')

      expect(res.status).toBe(200)
      expect(res.body.data.isDegraded).toBe(true)
      expect(res.body.data.status).toBe('DEGRADED')
      expect(res.body.data.availableForYield).toBe('0')
      expect(res.body.data.statusMessage).toBe(
        'your floor exceeds your balance; nothing is currently earning yield'
      )
    })

    it('returns 403 when trying to access another user floor', async () => {
      const res = await request(app).get(
        `/api/v1/liquidity-floor/${otherUserId}`
      )
      expect(res.status).toBe(403)
    })
  })

  describe('PUT /api/v1/liquidity-floor', () => {
    it('updates user liquidity floor and returns recalculated status', async () => {
      mockDb.user.update.mockResolvedValueOnce({
        id: mockUserId,
        liquidityFloor: '500',
      })

      mockDb.position.findMany.mockResolvedValueOnce([
        {
          id: 'pos-1',
          protocolName: 'Cash',
          assetSymbol: 'USDC',
          currentValue: '600',
          status: 'ACTIVE',
        },
      ])

      const res = await request(app)
        .put('/api/v1/liquidity-floor')
        .send({ liquidityFloor: 500 })

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data.floor).toBe('500')
      expect(res.body.data.isSatisfied).toBe(true)
      expect(mockDb.user.update).toHaveBeenCalledWith({
        where: { id: mockUserId },
        data: { liquidityFloor: '500' },
        select: { id: true, liquidityFloor: true },
      })
    })

    it('clears liquidity floor when set to null', async () => {
      mockDb.user.update.mockResolvedValueOnce({
        id: mockUserId,
        liquidityFloor: null,
      })

      mockDb.position.findMany.mockResolvedValueOnce([
        {
          id: 'pos-1',
          protocolName: 'Cash',
          assetSymbol: 'USDC',
          currentValue: '600',
          status: 'ACTIVE',
        },
      ])

      const res = await request(app)
        .put('/api/v1/liquidity-floor')
        .send({ liquidityFloor: null })

      expect(res.status).toBe(200)
      expect(res.body.data.status).toBe('NO_FLOOR')
      expect(mockDb.user.update).toHaveBeenCalledWith({
        where: { id: mockUserId },
        data: { liquidityFloor: null },
        select: { id: true, liquidityFloor: true },
      })
    })

    it('rejects negative liquidityFloor with 400', async () => {
      const res = await request(app)
        .put('/api/v1/liquidity-floor')
        .send({ liquidityFloor: -100 })

      expect(res.status).toBe(400)
    })
  })
})
