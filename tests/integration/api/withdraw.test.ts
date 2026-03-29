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

const mockWithdraw = jest.fn()

jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: mockDb,
  db: mockDb,
}))

jest.mock('../../../src/stellar/contract', () => ({
  deposit: jest.fn(),
  depositForUser: jest.fn(),
  withdraw: (...args: unknown[]) => mockWithdraw(...args),
  withdrawForUser: (...args: unknown[]) => mockWithdraw(...args),
  getOnChainBalance: jest.fn(),
  getOnChainAPY: jest.fn(),
  getActiveProtocol: jest.fn(),
}))

import request from 'supertest'
import app from '../../../src/index'

const USER_ID = '550e8400-e29b-41d4-a716-446655440004'
const TOKEN = 'withdraw-test-token'

const SESSION = {
  id: 'session-withdraw',
  userId: USER_ID,
  walletAddress: 'GWITHDRAWTESTPUBKEY',
  network: 'TESTNET',
  expiresAt: new Date(Date.now() + 3_600_000),
  user: { id: USER_ID, isActive: true },
}

const VALID_WITHDRAW = {
  userId: USER_ID,
  amount: 50,
  assetSymbol: 'USDC',
  protocolName: 'Blend',
}

function authHeader() {
  return { Authorization: `Bearer ${TOKEN}` }
}

describe('Withdraw route', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockDb.session.findUnique.mockResolvedValue(SESSION)
    mockDb.user.findUnique.mockResolvedValue({ id: USER_ID, network: 'TESTNET' })
    mockDb.transaction.findUnique.mockResolvedValue(null)
    mockWithdraw.mockResolvedValue({
      hash: 'withdraw-hash-0001',
      status: 'success',
      ledger: 77,
    })
    mockDb.transaction.create.mockResolvedValue({
      id: 'withdraw-tx-new',
      txHash: 'withdraw-hash-0001',
      status: 'CONFIRMED',
      amount: VALID_WITHDRAW.amount,
      assetSymbol: VALID_WITHDRAW.assetSymbol,
      protocolName: VALID_WITHDRAW.protocolName,
    })
  })

  it('returns 401 without auth token', async () => {
    const res = await request(app).post('/api/withdraw').send(VALID_WITHDRAW)
    expect(res.status).toBe(401)
  })

  it('returns 404 when user does not exist in DB', async () => {
    mockDb.user.findUnique.mockResolvedValue(null)

    const res = await request(app)
      .post('/api/withdraw')
      .set(authHeader())
      .send(VALID_WITHDRAW)

    expect(res.status).toBe(404)
    expect(res.body.error).toBe('User not found')
  })

  it('creates an on-chain withdrawal and stores the returned hash', async () => {
    const res = await request(app)
      .post('/api/withdraw')
      .set(authHeader())
      .send(VALID_WITHDRAW)

    expect(res.status).toBe(201)
    expect(mockWithdraw).toHaveBeenCalledWith(
      USER_ID,
      SESSION.walletAddress,
      VALID_WITHDRAW.amount,
    )
    expect(mockDb.transaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'WITHDRAWAL',
          status: 'CONFIRMED',
          txHash: 'withdraw-hash-0001',
          confirmedAt: expect.any(Date),
        }),
      }),
    )
    expect(res.body.transaction).toEqual(
      expect.objectContaining({
        txHash: 'withdraw-hash-0001',
        status: 'CONFIRMED',
        amount: VALID_WITHDRAW.amount,
      }),
    )
    expect(res.body.txHash).toBe('withdraw-hash-0001')
    expect(res.body.status).toBe('CONFIRMED')
  })

  it('returns 409 if the generated on-chain hash already exists', async () => {
    mockDb.transaction.findUnique.mockResolvedValue({ id: 'existing-withdraw-tx' })

    const res = await request(app)
      .post('/api/withdraw')
      .set(authHeader())
      .send(VALID_WITHDRAW)

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('Duplicate transaction hash')
  })
})
