import express from 'express'
import request from 'supertest'
import { Keypair } from '@stellar/stellar-sdk'
import db from '../../src/db'
import netWorthRouter from '../../src/routes/net-worth'

jest.mock('../../src/db', () => ({
  __esModule: true,
  default: {
    position: { findMany: jest.fn() },
    linkedExternalWallet: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      deleteMany: jest.fn(),
    },
    user: { findUnique: jest.fn() },
    custodialWallet: { findFirst: jest.fn() },
  },
}))
jest.mock('../../src/middleware/authenticate', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.auth = { userId: 'user-1' }
    req.authScopes = req.header('x-test-scopes')?.split(',') ?? ['*']
    next()
  },
}))
jest.mock('../../src/stellar/client', () => ({
  getExternalWalletBalances: jest.fn(),
}))

const mockDb = db as any
const app = express()
app.use(express.json())
app.use('/api/v1/net-worth', netWorthRouter)

beforeEach(() => {
  jest.clearAllMocks()
  process.env.USDC_ISSUER = 'GUSDC_ISSUER'
  mockDb.position.findMany.mockResolvedValue([
    {
      id: 'position-1',
      protocolName: 'Blend',
      assetSymbol: 'USDC',
      currentValue: 100,
    },
  ])
  mockDb.linkedExternalWallet.findMany.mockResolvedValue([
    {
      id: 'linked-1',
      userId: 'user-1',
      publicKey: Keypair.random().publicKey(),
      label: 'Freighter',
      verificationStatus: 'UNVERIFIED_SELF_REPORTED',
      balances: [
        {
          assetType: 'credit_alphanum4',
          assetCode: 'USDC',
          assetIssuer: 'GUSDC_ISSUER',
          amount: '25.5',
        },
        {
          assetType: 'native',
          assetCode: 'XLM',
          assetIssuer: null,
          amount: '3',
        },
      ],
      addedAt: new Date('2026-09-01T00:00:00.000Z'),
      lastSyncedAt: new Date(),
      syncError: null,
    },
  ])
  mockDb.user.findUnique.mockResolvedValue({ walletAddress: 'GUSER' })
  mockDb.custodialWallet.findFirst.mockResolvedValue(null)
  mockDb.linkedExternalWallet.findUnique.mockResolvedValue(null)
  mockDb.linkedExternalWallet.count.mockResolvedValue(0)
  mockDb.linkedExternalWallet.create.mockImplementation(
    async ({ data }: any) => ({ id: 'linked-new', ...data })
  )
  mockDb.linkedExternalWallet.deleteMany.mockResolvedValue({ count: 0 })
})

describe('net-worth and external wallet routes', () => {
  it('returns source-tagged personal holdings and labels unpriced balances', async () => {
    const res = await request(app).get('/api/v1/net-worth')

    expect(res.status).toBe(200)
    expect(res.body.totalKnownUsd).toBe(125.5)
    expect(res.body.holdings.map((holding: any) => holding.source)).toEqual([
      'platform',
      'external',
      'external',
    ])
    expect(res.body.holdings[2]).toMatchObject({
      assetCode: 'XLM',
      valueUsd: null,
      stale: false,
      verificationStatus: 'UNVERIFIED_SELF_REPORTED',
    })
    expect(mockDb.position.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1', status: 'ACTIVE' } })
    )
    expect(mockDb.linkedExternalWallet.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1' } })
    )
  })

  it('keeps and labels stale balances after a failed sync', async () => {
    const lastSyncedAt = new Date(Date.now() - 60 * 60 * 1000)
    mockDb.linkedExternalWallet.findMany.mockResolvedValue([
      {
        id: 'linked-1',
        userId: 'user-1',
        publicKey: Keypair.random().publicKey(),
        label: 'Freighter',
        verificationStatus: 'UNVERIFIED_SELF_REPORTED',
        balances: [
          {
            assetType: 'credit_alphanum4',
            assetCode: 'USDC',
            assetIssuer: 'GUSDC_ISSUER',
            amount: '25.5',
          },
        ],
        addedAt: new Date('2026-09-01T00:00:00.000Z'),
        lastSyncedAt,
        lastSyncAttemptAt: new Date(),
        syncError: 'Horizon unavailable',
      },
    ])

    const res = await request(app).get('/api/v1/net-worth')

    expect(res.status).toBe(200)
    expect(res.body.totalKnownUsd).toBe(125.5)
    expect(res.body.valuationComplete).toBe(false)
    expect(res.body.externalWallets[0]).toMatchObject({
      stale: true,
      syncFailed: true,
    })
    expect(res.body.holdings[1]).toMatchObject({
      stale: true,
      asOf: lastSyncedAt.toISOString(),
      valueUsd: 25.5,
    })
  })

  it('creates only an unverified self-reported link', async () => {
    const publicKey = Keypair.random().publicKey()
    const res = await request(app)
      .post('/api/v1/net-worth/external-wallets')
      .send({ publicKey, label: 'Lobstr' })

    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({
      publicKey,
      verificationStatus: 'UNVERIFIED_SELF_REPORTED',
      verified: false,
    })
    expect(mockDb.linkedExternalWallet.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        publicKey,
        label: 'Lobstr',
        verificationStatus: 'UNVERIFIED_SELF_REPORTED',
      },
    })
  })

  it('requires portfolio:write scope for API-key link mutations', async () => {
    const res = await request(app)
      .post('/api/v1/net-worth/external-wallets')
      .set('x-test-scopes', 'portfolio:read')
      .send({ publicKey: Keypair.random().publicKey(), label: 'Read-only key' })

    expect(res.status).toBe(403)
    expect(res.body.required).toBe('portfolio:write')
    expect(mockDb.linkedExternalWallet.create).not.toHaveBeenCalled()
  })

  it('cannot remove a linked wallet outside the authenticated tenant', async () => {
    const id = '5b7bd5c3-561f-4674-a58c-ea5071815621'
    const res = await request(app).delete(
      `/api/v1/net-worth/external-wallets/${id}`
    )

    expect(res.status).toBe(404)
    expect(mockDb.linkedExternalWallet.deleteMany).toHaveBeenCalledWith({
      where: { id, userId: 'user-1' },
    })
  })
})
