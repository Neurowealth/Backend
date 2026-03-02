import request from 'supertest'

const mockDb = {
  session: { findUnique: jest.fn() },
  user: { findUnique: jest.fn() },
  position: { findMany: jest.fn() },
  yieldSnapshot: { findMany: jest.fn() },
  transaction: {
    count: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
  },
  protocolRate: { findMany: jest.fn() },
  agentLog: { findFirst: jest.fn() },
}

jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: mockDb,
  db: mockDb,
}))

import app from '../../../src/index'

const userId = '550e8400-e29b-41d4-a716-446655440000'
const token = 'valid-token'

describe('API integration routes', () => {
  beforeEach(() => {
    jest.clearAllMocks()

    mockDb.session.findUnique.mockResolvedValue({
      id: 'session-1',
      userId,
      walletAddress: 'GABC',
      network: 'TESTNET',
      expiresAt: new Date(Date.now() + 60_000),
      user: { id: userId, isActive: true },
    })
  })

  describe('portfolio routes', () => {
    it('returns 401 without token', async () => {
      const res = await request(app).get(`/api/portfolio/${userId}`)

      expect(res.status).toBe(401)
      expect(res.body.error).toBe('Unauthorized')
    })

    it('returns 404 when user is missing', async () => {
      mockDb.user.findUnique.mockResolvedValue(null)

      const res = await request(app)
        .get(`/api/portfolio/${userId}`)
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(404)
      expect(res.body.error).toBe('User not found')
    })

    it('returns expected portfolio response shape', async () => {
      mockDb.user.findUnique.mockResolvedValue({
        id: userId,
      })
      mockDb.position.findMany.mockResolvedValue([
        {
          id: 'pos-1',
          protocolName: 'Blend',
          assetSymbol: 'USDC',
          currentValue: 5200,
          yieldEarned: 200,
          status: 'ACTIVE',
        },
      ])

      const res = await request(app)
        .get(`/api/portfolio/${userId}`)
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body).toEqual(
        expect.objectContaining({
          userId,
          totalBalance: 5200,
          totalEarnings: 200,
          activePositions: 1,
          positions: expect.any(Array),
          whatsappReply: expect.any(String),
        }),
      )
    })
  })

  describe('transaction routes', () => {
    it('uses default pagination limit = 5', async () => {
      mockDb.user.findUnique.mockResolvedValue({ id: userId })
      mockDb.transaction.count.mockResolvedValue(1)
      mockDb.transaction.findMany.mockResolvedValue([
        {
          id: 'tx-1',
          txHash: 'hash1',
          type: 'DEPOSIT',
          status: 'CONFIRMED',
          amount: 10,
          assetSymbol: 'USDC',
          protocolName: 'Blend',
          createdAt: new Date(),
        },
      ])

      const res = await request(app)
        .get(`/api/transactions/${userId}?page=1`)
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body.limit).toBe(5)
      expect(mockDb.transaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 5 }),
      )
    })
  })

  describe('deposit route', () => {
    it('returns 409 for duplicate tx hash', async () => {
      mockDb.user.findUnique.mockResolvedValue({ id: userId, network: 'TESTNET' })
      mockDb.transaction.findUnique.mockResolvedValue({ id: 'existing-tx' })

      const res = await request(app)
        .post('/api/deposit')
        .set('Authorization', `Bearer ${token}`)
        .send({
          userId,
          txHash: 'duplicate-hash-value-0001',
          amount: 100,
          assetSymbol: 'USDC',
          protocolName: 'Blend',
        })

      expect(res.status).toBe(409)
      expect(res.body.error).toBe('Duplicate transaction hash')
    })

    it('returns whatsappReply in successful response', async () => {
      mockDb.user.findUnique.mockResolvedValue({ id: userId, network: 'TESTNET' })
      mockDb.transaction.findUnique.mockResolvedValue(null)
      mockDb.transaction.create.mockResolvedValue({
        id: 'tx-2',
        txHash: 'new-hash-value-0002',
        status: 'PENDING',
        amount: 100,
        assetSymbol: 'USDC',
        protocolName: 'Blend',
      })

      const res = await request(app)
        .post('/api/deposit')
        .set('Authorization', `Bearer ${token}`)
        .send({
          userId,
          txHash: 'new-hash-value-0002',
          amount: 100,
          assetSymbol: 'USDC',
          protocolName: 'Blend',
        })

      expect(res.status).toBe(201)
      expect(res.body.whatsappReply).toEqual(expect.any(String))
      expect(res.body.transaction).toEqual(
        expect.objectContaining({
          txHash: 'new-hash-value-0002',
          amount: 100,
        }),
      )
    })
  })
})
