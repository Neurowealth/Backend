import request from 'supertest'

import db from '../../src/db'
import app from '../../src'
import { JwtAdapter } from '../../src/config'
import {
  createLotForDeposit,
  recordDisposalsForWithdrawal,
} from '../../src/tax/service'

// Keep the server boot from polling real RPC / emitting external alerts.
jest.mock('../../src/stellar/events', () => {
  const actual = jest.requireActual('../../src/stellar/events')
  return {
    __esModule: true,
    ...actual,
    startEventListener: jest.fn().mockResolvedValue(undefined),
    stopEventListener: jest.fn(),
  }
})
jest.mock('../../src/services/alerting', () => ({
  alertingService: {
    emit: jest.fn().mockResolvedValue({ sent: true }),
    emitDLQAlert: jest.fn(),
    clearDLQAlertState: jest.fn(),
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

function uuid(): string {
  return `t-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

async function seedUserWithSession(): Promise<{
  userId: string
  token: string
}> {
  const walletAddress =
    `G${uuid().replace(/-/g, '').slice(0, 47)}TAXREPORT`.slice(0, 56)

  const user = await db.user.create({
    data: {
      walletAddress,
      network: 'TESTNET',
      displayName: 'Tax IT',
      email: `tax-${Date.now()}-${Math.random()}@example.com`,
      isActive: true,
    },
  })

  const token = (await JwtAdapter.generateToken({ id: user.id })) as string
  await db.session.create({
    data: {
      userId: user.id,
      token,
      walletAddress,
      network: 'TESTNET',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  })

  return { userId: user.id, token }
}

async function seedConfirmedTransaction(
  userId: string,
  type: 'DEPOSIT' | 'WITHDRAWAL',
  assetSymbol: string,
  amount: string,
  confirmedAt: Date
) {
  return db.transaction.create({
    data: {
      userId,
      txHash: `tx-${uuid()}`,
      type,
      status: 'CONFIRMED',
      assetSymbol,
      amount,
      network: 'TESTNET',
      confirmedAt,
    },
  })
}

describe('GET /api/v1/portfolio/:userId/tax-report (#284)', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const { userId } = await seedUserWithSession()

    const res = await request(app).get(
      `/api/v1/portfolio/${userId}/tax-report?year=2026`
    )

    expect(res.status).toBe(401)
  })

  it("rejects another user's report with 401 (enforceUserAccess)", async () => {
    const alice = await seedUserWithSession()
    const bob = await seedUserWithSession()

    const res = await request(app)
      .get(`/api/v1/portfolio/${bob.userId}/tax-report?year=2026`)
      .set('Authorization', `Bearer ${alice.token}`)

    expect(res.status).toBe(401)
  })

  it('returns the FIFO report as JSON with priced totals', async () => {
    const { userId, token } = await seedUserWithSession()

    const deposit = await seedConfirmedTransaction(
      userId,
      'DEPOSIT',
      'USDC',
      '100',
      new Date('2026-01-15T00:00:00Z')
    )
    await createLotForDeposit(
      userId,
      deposit.id,
      'USDC',
      '100',
      deposit.confirmedAt as Date
    )

    const withdrawal = await seedConfirmedTransaction(
      userId,
      'WITHDRAWAL',
      'USDC',
      '40',
      new Date('2026-06-15T00:00:00Z')
    )
    await recordDisposalsForWithdrawal(
      userId,
      withdrawal.id,
      'USDC',
      '40',
      withdrawal.confirmedAt as Date
    )

    const res = await request(app)
      .get(`/api/v1/portfolio/${userId}/tax-report?year=2026`)
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body.method).toBe('FIFO')
    expect(res.body.disposals).toHaveLength(1)
    expect(res.body.disposals[0]).toMatchObject({
      assetSymbol: 'USDC',
      amount: '40',
      priced: true,
      realizedGain: '0',
      withdrawalTxHash: withdrawal.txHash,
      acquisitionTxHash: deposit.txHash,
    })
    expect(res.body.totals).toEqual({
      proceeds: '40',
      costBasis: '40',
      realizedGain: '0',
      pricedDisposalCount: 1,
    })

    // Lot remaining was decremented in the database.
    const lot = await db.costBasisLot.findUnique({
      where: { transactionId: deposit.id },
    })
    expect(Number(lot!.remainingAmount)).toBe(60)
  })

  it('returns CSV with headers and injection-safe cells', async () => {
    const { userId, token } = await seedUserWithSession()

    // Excel-hostile asset symbol: must arrive prefixed, never as a formula.
    const evilAsset = '=SUM(A1:A9)'
    const deposit = await seedConfirmedTransaction(
      userId,
      'DEPOSIT',
      evilAsset,
      '10',
      new Date('2026-02-01T00:00:00Z')
    )
    await createLotForDeposit(
      userId,
      deposit.id,
      evilAsset,
      '10',
      deposit.confirmedAt as Date
    )
    const withdrawal = await seedConfirmedTransaction(
      userId,
      'WITHDRAWAL',
      evilAsset,
      '10',
      new Date('2026-03-01T00:00:00Z')
    )
    await recordDisposalsForWithdrawal(
      userId,
      withdrawal.id,
      evilAsset,
      '10',
      withdrawal.confirmedAt as Date
    )

    const res = await request(app)
      .get(`/api/v1/portfolio/${userId}/tax-report?year=2026&format=csv`)
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/csv')
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="tax-report-2026.csv"'
    )
    const [headerLine, firstRow] = res.text.split('\r\n')
    expect(headerLine).toBe(
      'disposedAt,assetSymbol,amount,withdrawalTxHash,acquiredAt,acquisitionTxHash,acquisitionPrice,disposalPrice,costBasis,proceeds,realizedGain,priced'
    )
    expect(firstRow).toContain(`,'=SUM(A1:A9),`)
    expect(firstRow).not.toContain(',=SUM')
  })

  it('returns a valid empty report for a year with no activity', async () => {
    const { userId, token } = await seedUserWithSession()

    const res = await request(app)
      .get(`/api/v1/portfolio/${userId}/tax-report?year=2020`)
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body.disposals).toEqual([])
    expect(res.body.totals.realizedGain).toBe('0')
    expect(res.body.caveats.unpricedDisposalCount).toBe(0)
  })

  it('rejects an invalid year with 400', async () => {
    const { userId, token } = await seedUserWithSession()

    const res = await request(app)
      .get(`/api/v1/portfolio/${userId}/tax-report?year=notayear`)
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(400)
  })
})
