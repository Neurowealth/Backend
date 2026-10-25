// Reserve reconciliation job (#339) — `reconcileOnce` walks ACTIVE
// ReserveSponsorship rows against on-chain sponsor state and classifies drift.
//
// These tests pin the four behaviours the interval depends on:
//   1. No active sponsorships → zero outstanding, no drift, no alert.
//   2. Matching on-chain sponsor + matching reserve → no drift.
//   3. Drift is not raised when a pending outbox op is still in flight.
//   4. A getAccount/Horizon failure is logged and never escapes the loop.
//
// db and getAccount are both mocked, so nothing here touches a network or a
// real Postgres instance.

process.env.NODE_ENV = 'test'

import db from '../../../src/db'
import { getAccount } from '../../../src/stellar/client'
import { reconcileOnce } from '../../../src/jobs/reserveReconciliation'
import { alertingService } from '../../../src/services/alerting'

jest.mock('../../../src/db', () => {
  const reserveFindMany = jest.fn()
  const outboxFindMany = jest.fn()
  const walletFindUnique = jest.fn()
  const client: any = {
    reserveSponsorship: { findMany: reserveFindMany },
    outboxOp: { findMany: outboxFindMany },
    custodialWallet: { findUnique: walletFindUnique },
  }
  return {
    __esModule: true,
    default: client,
    __mockReserveFindMany: reserveFindMany,
    __mockOutboxFindMany: outboxFindMany,
    __mockWalletFindUnique: walletFindUnique,
  }
})

jest.mock('../../../src/stellar/client', () => ({
  getAccount: jest.fn(),
}))

jest.mock('../../../src/services/alerting', () => ({
  alertingService: { emit: jest.fn().mockResolvedValue(undefined) },
}))

jest.mock('../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

// Prom-client gauges are process-global; stub them so the test asserts on the
// job's return value instead of on registry internals.
jest.mock('../../../src/utils/metrics', () => ({
  reserveOutstandingXlm: { set: jest.fn() },
  sponsorAvailableXlmGauge: { set: jest.fn() },
  reserveReconciliationDrift: { set: jest.fn() },
  sponsorCapacityExhaustedTotal: { inc: jest.fn() },
}))

const dbMock = require('../../../src/db')
const mockReserveFindMany: jest.Mock = dbMock.__mockReserveFindMany
const mockOutboxFindMany: jest.Mock = dbMock.__mockOutboxFindMany
const mockWalletFindUnique: jest.Mock = dbMock.__mockWalletFindUnique
const mockGetAccount = getAccount as jest.Mock
const mockEmit = alertingService.emit as jest.Mock

function activeSponsorship(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rs-1',
    sponsoredId: 'wallet-1',
    sponsorAccount: 'GSPONSOR',
    entryType: 'ACCOUNT',
    ledgerKey: 'wallet-1',
    xlmReserved: 1,
    status: 'ACTIVE',
    createdAt: new Date(),
    revokedAt: null,
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  delete process.env.STELLAR_SPONSOR_KEYS
  delete process.env.STELLAR_SPONSOR_SECRET_KEY
  delete process.env.STELLAR_AGENT_SECRET_KEY
  mockOutboxFindMany.mockResolvedValue([])
  mockGetAccount.mockResolvedValue({ sponsor: 'GSPONSOR' })
})

describe('reconcileOnce — no active sponsorships', () => {
  it('reports zero outstanding and no drift', async () => {
    mockReserveFindMany.mockResolvedValue([])

    const result = await reconcileOnce()

    expect(result).toEqual({ driftCount: 0, outstandingXlm: 0 })
    expect(mockWalletFindUnique).not.toHaveBeenCalled()
    expect(mockEmit).not.toHaveBeenCalled()
  })

  it('still reads pending outbox ops so the query shape is pinned', async () => {
    mockReserveFindMany.mockResolvedValue([])

    await reconcileOnce()

    expect(mockOutboxFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ kind: 'ACCOUNT_PROVISION' }),
      })
    )
  })
})

describe('reconcileOnce — healthy sponsorships', () => {
  it('raises no drift when sponsor and reserve match on-chain', async () => {
    mockReserveFindMany.mockResolvedValue([
      activeSponsorship({ xlmReserved: 1 }),
    ])
    mockWalletFindUnique.mockResolvedValue({ publicKey: 'GACCOUNT' })
    mockGetAccount.mockResolvedValue({ sponsor: 'GSPONSOR' })

    const result = await reconcileOnce()

    expect(result.driftCount).toBe(0)
    expect(result.outstandingXlm).toBe(1)
    expect(mockEmit).not.toHaveBeenCalled()
  })

  it('sums outstanding XLM across every active row', async () => {
    mockReserveFindMany.mockResolvedValue([
      activeSponsorship({ id: 'rs-1', xlmReserved: 1 }),
      activeSponsorship({ id: 'rs-2', xlmReserved: 2.5 }),
      activeSponsorship({ id: 'rs-3', xlmReserved: 0.5 }),
    ])

    const result = await reconcileOnce()

    expect(result.outstandingXlm).toBe(4)
  })

  it('accepts the half-XLM reserve for TRUSTLINE entries', async () => {
    mockReserveFindMany.mockResolvedValue([
      activeSponsorship({ entryType: 'TRUSTLINE', xlmReserved: 0.5 }),
    ])
    mockWalletFindUnique.mockResolvedValue({ publicKey: 'GACCOUNT' })
    mockGetAccount.mockResolvedValue({ sponsor: 'GSPONSOR' })

    const result = await reconcileOnce()

    expect(result.driftCount).toBe(0)
  })

  it('tolerates Decimal xlmReserved values from Prisma', async () => {
    mockReserveFindMany.mockResolvedValue([
      activeSponsorship({
        xlmReserved: { toString: () => '1.000000000000000001' },
      }),
    ])

    const result = await reconcileOnce()

    expect(result.outstandingXlm).toBeCloseTo(1, 6)
  })
})

describe('reconcileOnce — drift classification', () => {
  it('counts a missing custodial wallet as drift', async () => {
    mockReserveFindMany.mockResolvedValue([
      activeSponsorship({ xlmReserved: 1 }),
    ])
    mockWalletFindUnique.mockResolvedValue(null)

    const result = await reconcileOnce()

    expect(result.driftCount).toBe(1)
    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'warning' }),
      'reserve:drift'
    )
  })

  it('counts an account missing on-chain as drift', async () => {
    mockReserveFindMany.mockResolvedValue([
      activeSponsorship({ xlmReserved: 1 }),
    ])
    mockWalletFindUnique.mockResolvedValue({ publicKey: 'GONE' })
    mockGetAccount.mockResolvedValue(null)

    const result = await reconcileOnce()

    expect(result.driftCount).toBe(1)
  })

  it('counts a mismatched on-chain sponsor as drift', async () => {
    mockReserveFindMany.mockResolvedValue([
      activeSponsorship({ sponsorAccount: 'GSPONSOR', xlmReserved: 1 }),
    ])
    mockWalletFindUnique.mockResolvedValue({ publicKey: 'GACCOUNT' })
    mockGetAccount.mockResolvedValue({ sponsor: 'GOTHER' })

    const result = await reconcileOnce()

    expect(result.driftCount).toBe(1)
  })

  it('counts a reserve that does not match the protocol minimum', async () => {
    mockReserveFindMany.mockResolvedValue([
      activeSponsorship({ entryType: 'ACCOUNT', xlmReserved: 5 }),
    ])
    mockWalletFindUnique.mockResolvedValue({ publicKey: 'GACCOUNT' })
    mockGetAccount.mockResolvedValue({ sponsor: 'GSPONSOR' })

    const result = await reconcileOnce()

    expect(result.driftCount).toBe(1)
  })

  it('skips rows with a pending outbox op instead of reporting in-flight work as drift', async () => {
    mockReserveFindMany.mockResolvedValue([
      activeSponsorship({ sponsoredId: 'wallet-1', xlmReserved: 1 }),
      activeSponsorship({
        id: 'rs-2',
        sponsoredId: 'wallet-2',
        xlmReserved: 1,
      }),
    ])
    mockOutboxFindMany.mockResolvedValue([
      { payload: { sponsoredId: 'wallet-1' } },
    ])
    mockWalletFindUnique.mockResolvedValue(null)

    const result = await reconcileOnce()

    // wallet-1 is skipped (pending provision), wallet-2 is genuine drift.
    expect(result.driftCount).toBe(1)
    expect(mockWalletFindUnique).toHaveBeenCalledTimes(1)
    expect(mockWalletFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'wallet-2' } })
    )
  })

  it('does not treat a payload without sponsoredId as in-flight', async () => {
    mockReserveFindMany.mockResolvedValue([
      activeSponsorship({ sponsoredId: 'wallet-1', xlmReserved: 1 }),
    ])
    mockOutboxFindMany.mockResolvedValue([{ payload: { other: 'value' } }])
    mockWalletFindUnique.mockResolvedValue(null)

    const result = await reconcileOnce()

    expect(result.driftCount).toBe(1)
  })
})

describe('reconcileOnce — resilience of the interval', () => {
  it('does not crash the interval when getAccount throws', async () => {
    mockReserveFindMany.mockResolvedValue([
      activeSponsorship({ xlmReserved: 1 }),
    ])
    mockWalletFindUnique.mockResolvedValue({ publicKey: 'GACCOUNT' })
    mockGetAccount.mockRejectedValue(new Error('Horizon unreachable'))

    const result = await reconcileOnce()

    expect(result.driftCount).toBe(1)
  })

  it('keeps processing later rows after one row throws', async () => {
    mockReserveFindMany.mockResolvedValue([
      activeSponsorship({
        id: 'rs-1',
        sponsoredId: 'wallet-1',
        xlmReserved: 1,
      }),
      activeSponsorship({
        id: 'rs-2',
        sponsoredId: 'wallet-2',
        xlmReserved: 1,
      }),
    ])
    mockWalletFindUnique.mockResolvedValue({ publicKey: 'GACCOUNT' })
    // The first lookup rejects; the loop must still reach the second row
    // instead of aborting the whole pass.
    mockGetAccount
      .mockRejectedValueOnce(new Error('Horizon 503'))
      .mockResolvedValueOnce(null)

    const result = await reconcileOnce()

    // A rejected lookup is coerced to null, which the job treats as drift, so
    // both rows are counted — what matters here is that row 2 was still
    // visited and the pass completed rather than throwing.
    expect(result.driftCount).toBe(2)
    expect(mockGetAccount).toHaveBeenCalledTimes(2)
  })

  it('never lets an alerting failure escape the job', async () => {
    mockReserveFindMany.mockResolvedValue([
      activeSponsorship({ xlmReserved: 1 }),
    ])
    mockWalletFindUnique.mockResolvedValue(null)
    mockEmit.mockRejectedValue(new Error('alerting down'))

    await expect(reconcileOnce()).resolves.toEqual({
      driftCount: 1,
      outstandingXlm: 1,
    })
  })

  it('reads sponsor balances from STELLAR_SPONSOR_KEYS when configured', async () => {
    process.env.STELLAR_SPONSOR_KEYS =
      'SCLJJ2L3RDN2HQXQ4IL5NTWB77D3OMGVKH36M5JDQQIHS3BUPLACCAGC'
    mockReserveFindMany.mockResolvedValue([])

    await reconcileOnce()

    expect(mockGetAccount).toHaveBeenCalled()
  })

  it('skips an unparseable sponsor key without crashing the interval', async () => {
    process.env.STELLAR_SPONSOR_KEYS = 'not-a-real-secret'
    mockReserveFindMany.mockResolvedValue([])

    await expect(reconcileOnce()).resolves.toEqual({
      driftCount: 0,
      outstandingXlm: 0,
    })
  })
})
