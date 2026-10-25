process.env.NODE_ENV = 'test'

import express, { NextFunction, Request, Response } from 'express'
import request from 'supertest'
import { Network } from '@prisma/client'
import liquidityFloorRouter from '../../../src/routes/liquidity-floor'

const mockUserFindUnique = jest.fn()
const mockUserUpdateMany = jest.fn()
const mockPositionFindMany = jest.fn()
const mockSnapshotFindMany = jest.fn()

jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: {
    user: {
      findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
      updateMany: (...args: unknown[]) => mockUserUpdateMany(...args),
    },
    position: {
      findMany: (...args: unknown[]) => mockPositionFindMany(...args),
    },
    protocolLiquiditySnapshot: {
      findMany: (...args: unknown[]) => mockSnapshotFindMany(...args),
    },
  },
}))

jest.mock('../../../src/middleware/authenticate', () => ({
  requireAuth: (req: Request, res: Response, next: NextFunction) => {
    if (!req.headers.authorization) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    req.userId = 'caller-id'
    req.auth = {
      userId: 'caller-id',
      sessionId: 'session-id',
      walletAddress: 'GTEST',
      network: Network.MAINNET,
    }
    next()
  },
}))

const app = express()
app.use(express.json())
app.use('/liquidity-floor', liquidityFloorRouter)

beforeEach(() => {
  jest.clearAllMocks()
  mockUserFindUnique.mockResolvedValue({ liquidityFloor: '50' })
  mockUserUpdateMany.mockResolvedValue({ count: 1 })
  mockPositionFindMany.mockResolvedValue([])
  mockSnapshotFindMany.mockResolvedValue([])
})

describe('liquidity-floor routes', () => {
  it('requires authentication', async () => {
    const response = await request(app).get('/liquidity-floor')
    expect(response.status).toBe(401)
  })

  it('updates only the authenticated user and returns status', async () => {
    mockUserFindUnique.mockResolvedValue({ liquidityFloor: '250' })
    const response = await request(app)
      .patch('/liquidity-floor')
      .set('Authorization', 'Bearer test-token')
      .send({ floorUsd: 250 })

    expect(response.status).toBe(200)
    expect(mockUserUpdateMany).toHaveBeenCalledWith({
      where: { id: 'caller-id' },
      data: { liquidityFloor: '250' },
    })
    expect(response.body.floorUsd).toBe(250)
  })

  it('clears the floor when floorUsd is null', async () => {
    mockUserFindUnique.mockResolvedValue({ liquidityFloor: null })
    const response = await request(app)
      .patch('/liquidity-floor')
      .set('Authorization', 'Bearer test-token')
      .send({ floorUsd: null })

    expect(response.status).toBe(200)
    expect(mockUserUpdateMany).toHaveBeenCalledWith({
      where: { id: 'caller-id' },
      data: { liquidityFloor: null },
    })
  })

  it('rejects negative floors', async () => {
    const response = await request(app)
      .patch('/liquidity-floor')
      .set('Authorization', 'Bearer test-token')
      .send({ floorUsd: -1 })

    expect(response.status).toBe(400)
    expect(mockUserUpdateMany).not.toHaveBeenCalled()
  })
})
