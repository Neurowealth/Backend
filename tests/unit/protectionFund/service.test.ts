/**
 * Protocol-Risk Protection Fund service tests (#533).
 */

process.env.NODE_ENV = 'test'

import { Keypair } from '@stellar/stellar-sdk'
import { Prisma } from '@prisma/client'
import {
  computeClaimsForEvent,
  declareCoverageEvent,
  executePayout,
  getCoverageTerms,
  getFundBalance,
  getMyCoverage,
  getProtectionFundStatus,
  recordContribution,
  reviewCoverageEvent,
} from '../../../src/protectionFund/service'

jest.mock('../../../src/db', () => {
  const findUnique = jest.fn()
  const findMany = jest.fn()
  const create = jest.fn()
  const update = jest.fn()
  const upsert = jest.fn()
  const $queryRaw = jest.fn()
  const aggregate = jest.fn()
  const userFindUnique = jest.fn()
  const client: any = {
    user: { findUnique: userFindUnique },
    protectionFundBalance: { findUnique, upsert, update },
    protectionFundContribution: { create, findMany },
    coverageEvent: { create, findUnique, update, findMany },
    coverageClaim: { create, findUnique, update, findMany, aggregate },
    position: { findMany },
    $queryRaw,
    $transaction: jest.fn(async (callback) => callback(client)),
  }
  return {
    __esModule: true,
    default: client,
    db: client,
    __mockFindUnique: findUnique,
    __mockFindMany: findMany,
    __mockCreate: create,
    __mockUpdate: update,
    __mockUpsert: upsert,
    __mockUserFindUnique: userFindUnique,
    __mockQueryRaw: $queryRaw,
    __mockClaimAggregate: aggregate,
  }
})

jest.mock('../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock('../../../src/outbox/service', () => ({
  enqueueOutboxOp: jest.fn().mockResolvedValue({ id: 'outbox-op-1' }),
}))

jest.mock('../../../src/audit/chain', () => ({
  appendAuditBlock: jest.fn(),
}))

const dbMock = require('../../../src/db')
const mockFindUnique: jest.Mock = dbMock.__mockFindUnique
const mockFindMany: jest.Mock = dbMock.__mockFindMany
const mockCreate: jest.Mock = dbMock.__mockCreate
const mockUpdate: jest.Mock = dbMock.__mockUpdate
const mockUpsert: jest.Mock = dbMock.__mockUpsert
const mockQueryRaw: jest.Mock = dbMock.__mockQueryRaw
const mockClaimAggregate: jest.Mock = dbMock.__mockClaimAggregate

describe('src/protectionFund/service', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockQueryRaw.mockResolvedValue([])
    mockClaimAggregate.mockResolvedValue({ _sum: { payoutAmount: null } })
  })

  describe('getCoverageTerms', () => {
    it('returns the published coverage terms', () => {
      const terms = getCoverageTerms()
      expect(terms.perUserCoverageCap).toBeGreaterThan(0)
      expect(terms.minHoldDurationMs).toBeGreaterThan(0)
      expect(terms.coveredCauses).toContain('EXPLOIT')
      expect(terms.coveredCauses).toContain('INSOLVENCY')
      expect(terms.excludedCauses).toContain('MARKET_PRICE_LOSS')
    })
  })

  describe('getFundBalance', () => {
    it('returns zero for an unknown asset', async () => {
      mockFindUnique.mockResolvedValue(null)
      const balance = await getFundBalance('USDC')
      expect(balance.amount).toBe(0)
      expect(balance.status).toBe('BOOTSTRAP')
    })

    it('returns the balance for a known asset', async () => {
      mockFindUnique.mockResolvedValue({
        assetSymbol: 'USDC',
        amount: '50000',
        status: 'ACTIVE',
      })
      const balance = await getFundBalance('USDC')
      expect(balance.amount).toBe(50000)
      expect(balance.status).toBe('ACTIVE')
    })
  })

  describe('recordContribution', () => {
    it('creates a contribution and updates the balance', async () => {
      mockCreate.mockResolvedValue({ id: 'contrib-1', amount: '1000' })
      mockUpsert.mockResolvedValue({ assetSymbol: 'USDC', amount: '1000' })

      const result = await recordContribution({
        source: 'REVENUE_SKIM',
        assetSymbol: 'USDC',
        amount: 1000,
      })

      expect(result.id).toBe('contrib-1')
      expect(mockCreate).toHaveBeenCalled()
      expect(mockUpsert).toHaveBeenCalled()
    })
  })

  describe('declareCoverageEvent', () => {
    it('creates a pending coverage event', async () => {
      mockCreate.mockResolvedValue({ id: 'event-1', status: 'PENDING_REVIEW' })

      const event = await declareCoverageEvent({
        protocolName: 'Blend',
        cause: 'EXPLOIT',
        lossWindowStart: '2026-09-01T00:00:00Z',
        lossWindowEnd: '2026-09-02T00:00:00Z',
        totalPlatformExposure: 100000,
        description: 'Exploit of Blend protocol',
        declaredBy: 'admin-1',
      })

      expect(event.id).toBe('event-1')
      expect(event.status).toBe('PENDING_REVIEW')
    })

    it('rejects non-covered causes', async () => {
      await expect(
        declareCoverageEvent({
          protocolName: 'Blend',
          cause: 'MARKET_PRICE_LOSS' as any,
          lossWindowStart: '2026-09-01T00:00:00Z',
          lossWindowEnd: '2026-09-02T00:00:00Z',
          totalPlatformExposure: 100000,
          description: 'Price dropped',
          declaredBy: 'admin-1',
        })
      ).rejects.toThrow('not a covered event type')
    })
  })

  describe('reviewCoverageEvent', () => {
    it('approves and computes claims', async () => {
      mockFindUnique.mockResolvedValue({
        id: 'event-1',
        status: 'PENDING_REVIEW',
      })
      mockUpdate.mockResolvedValue({ id: 'event-1', status: 'APPROVED' })
      mockFindMany.mockResolvedValue([])

      const result = await reviewCoverageEvent('event-1', true, 'admin-2')

      expect(result.status).toBe('APPROVED')
    })

    it('rejects an event that is not pending', async () => {
      mockFindUnique.mockResolvedValue({ id: 'event-1', status: 'APPROVED' })

      await expect(
        reviewCoverageEvent('event-1', true, 'admin-2')
      ).rejects.toThrow('not pending review')
    })

    it('rejects a review by the same admin who declared the event (#758)', async () => {
      mockFindUnique.mockResolvedValue({
        id: 'event-1',
        status: 'PENDING_REVIEW',
        declaredBy: 'admin-1',
      })

      await expect(
        reviewCoverageEvent('event-1', true, 'admin-1')
      ).rejects.toThrow('different admin than the declarer')
      expect(mockUpdate).not.toHaveBeenCalled()
    })
  })

  describe('getMyCoverage', () => {
    it('returns coverage info for a user', async () => {
      mockFindMany.mockResolvedValue([
        {
          id: 'pos-1',
          protocolName: 'Blend',
          assetSymbol: 'USDC',
          currentValue: '5000',
          createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        },
      ])
      mockFindUnique.mockResolvedValue({
        assetSymbol: 'USDC',
        amount: '50000',
        status: 'ACTIVE',
      })

      const coverage = await getMyCoverage('user-1')

      expect(coverage.totalPositions).toBe(1)
      expect(coverage.coveredProtocols).toContain('Blend')
      expect(coverage.exposure[0].eligibleForCoverage).toBe(true)
    })
  })

  describe('computeClaimsForEvent', () => {
    it('allocates only the balance not already reserved by pending claims', async () => {
      mockFindUnique
        .mockResolvedValueOnce({
          id: 'event-2',
          protocolName: 'Blend',
          lossWindowStart: '2026-09-01T00:00:00Z',
          lossWindowEnd: '2026-09-02T00:00:00Z',
        })
        .mockResolvedValueOnce({ amount: new Prisma.Decimal(100) })
      mockClaimAggregate.mockResolvedValue({
        _sum: { payoutAmount: new Prisma.Decimal(70) },
      })
      mockFindMany.mockResolvedValue([
        {
          id: 'position-2',
          userId: 'user-2',
          protocolName: 'Blend',
          status: 'ACTIVE',
          openedAt: new Date('2026-08-01T00:00:00Z'),
          currentValue: new Prisma.Decimal(0),
          transactions: [
            {
              type: 'DEPOSIT',
              amount: new Prisma.Decimal(100),
              createdAt: new Date('2026-09-01T12:00:00Z'),
            },
          ],
        },
      ])
      mockCreate.mockResolvedValue({ id: 'claim-2', status: 'PENDING' })

      const claims = await computeClaimsForEvent('event-2')

      expect(claims).toEqual([
        expect.objectContaining({
          payoutAmount: 30,
          coverageType: 'PRORATED',
          status: 'PENDING',
        }),
      ])
      expect(mockClaimAggregate).toHaveBeenCalledWith({
        where: { status: 'PENDING' },
        _sum: { payoutAmount: true },
      })
      expect(mockQueryRaw).toHaveBeenCalled()
    })
  })

  describe('getProtectionFundStatus', () => {
    it('returns the public status', async () => {
      mockFindUnique.mockResolvedValue({
        assetSymbol: 'USDC',
        amount: '50000',
        status: 'ACTIVE',
      })
      mockFindMany
        .mockResolvedValueOnce([
          {
            id: 'c1',
            source: 'REVENUE_SKIM',
            assetSymbol: 'USDC',
            amount: '1000',
            createdAt: new Date(),
          },
        ])
        .mockResolvedValueOnce([
          {
            id: 'e1',
            protocolName: 'Blend',
            cause: 'EXPLOIT',
            status: 'APPROVED',
            totalPlatformExposure: '100000',
            lossWindowStart: '2026-09-01',
            lossWindowEnd: '2026-09-02',
            createdAt: new Date(),
          },
        ])

      const status = await getProtectionFundStatus()

      expect(status.fundBalance.amount).toBe(50000)
      expect(status.recentContributions).toHaveLength(1)
      expect(status.historicalEvents).toHaveLength(1)
    })
  })
})

describe('executePayout — recipient address (#825)', () => {
  const { enqueueOutboxOp } = require('../../../src/outbox/service')
  const mockUserFindUnique: jest.Mock = dbMock.__mockUserFindUnique

  beforeEach(() => {
    ;(enqueueOutboxOp as jest.Mock).mockClear()
    mockFindUnique.mockResolvedValue({
      id: 'claim-1',
      userId: 'u1',
      eventId: 'event-1',
      status: 'PENDING',
      payoutAmount: new Prisma.Decimal(250),
      event: {},
    })
  })

  it('queues the payout to the claimant address', async () => {
    const address = Keypair.random().publicKey()
    mockUserFindUnique.mockResolvedValue({ walletAddress: address })

    await executePayout('claim-1')

    expect(enqueueOutboxOp).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        payload: expect.objectContaining({
          method: 'protection_fund_payout',
          userAddress: address,
          claimId: 'claim-1',
        }),
      })
    )
  })

  it('refuses to queue a payout to an invalid address', async () => {
    mockUserFindUnique.mockResolvedValue({ walletAddress: 'GNOTAKEY' })

    await expect(executePayout('claim-1')).rejects.toThrow(
      'not a valid Stellar public key'
    )
    expect(enqueueOutboxOp).not.toHaveBeenCalled()
  })
})
