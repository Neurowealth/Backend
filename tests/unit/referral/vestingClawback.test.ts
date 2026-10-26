import { Decimal } from '@prisma/client/runtime/library'
import db from '../../../src/db'
import { getWalletByUserId } from '../../../src/stellar/wallet'
import {
  REFERRAL_VESTING_DISCLOSURE_COPY,
  buildVestingTrancheSchedule,
  evaluateReferredBalanceCheckpoint,
  recordEarlyWithdrawalClawback,
  applyClawbackOffsetToReward,
  expireStaleClawbacks,
  sweepVestingTranchesAndClawbacks,
} from '../../../src/referral/vesting'
import {
  checkAndActivateOnDeposit,
  payoutActivatedConversions,
  getReferralMeSummary,
} from '../../../src/referral/service'

jest.mock('../../../src/db', () => ({ __esModule: true, default: {} }))
jest.mock('../../../src/utils/logger', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}))
jest.mock('../../../src/services/alerting', () => ({
  alertingService: { emit: jest.fn().mockResolvedValue({ sent: true }) },
}))
jest.mock('../../../src/stellar/wallet', () => ({
  getWalletByUserId: jest.fn(),
}))

const mockPublishUserEvent = jest.fn().mockResolvedValue(undefined)
jest.mock('../../../src/events/publisher', () => ({
  publishUserEvent: (...args: unknown[]) => mockPublishUserEvent(...args),
}))

const mockEnqueueOutboxOp = jest.fn()
const mockDispatchOne = jest.fn()
jest.mock('../../../src/outbox/service', () => ({
  enqueueOutboxOp: (...args: unknown[]) => mockEnqueueOutboxOp(...args),
}))
jest.mock('../../../src/outbox/dispatcher', () => ({
  dispatchOne: (...args: unknown[]) => mockDispatchOne(...args),
}))

const mockDb = db as any
const mockGetWallet = getWalletByUserId as jest.Mock

describe('Referral Reward Vesting & Early-Withdrawal Clawback (#364)', () => {
  const baseDate = new Date('2026-10-27T00:00:00.000Z')

  beforeEach(() => {
    jest.clearAllMocks()
    mockDb.referralCode = {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
    }
    mockDb.referralConversion = {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    }
    mockDb.referralRewardTranche = {
      createMany: jest.fn().mockResolvedValue({ count: 6 }),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
    }
    mockDb.referralClawback = {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation(({ data }: any) => ({
        id: 'cb-1',
        ...data,
      })),
      update: jest.fn().mockResolvedValue({}),
    }
    mockDb.yieldSnapshot = {
      findMany: jest.fn().mockResolvedValue([]),
    }
    mockDb.position = {
      findMany: jest.fn().mockResolvedValue([]),
    }
    mockDb.user = {
      findUnique: jest.fn().mockResolvedValue({ network: 'MAINNET' }),
    }
    mockDb.transaction = {
      create: jest.fn().mockImplementation(({ data }: any) => ({
        id: `tx-${data.userId}-${Math.random().toString(36).slice(2, 6)}`,
      })),
      update: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    }
    mockDb.session = {
      findMany: jest.fn().mockResolvedValue([]),
    }
    mockDb.auditPayloadHash = {
      create: jest.fn().mockResolvedValue({ id: 'audit-1' }),
    }
    mockDb.$transaction = jest.fn((fn: (tx: any) => unknown) => fn(mockDb))
    mockGetWallet.mockResolvedValue({ publicKey: 'GADDRESS123' })
    mockEnqueueOutboxOp.mockResolvedValue({ id: 'op-1' })
    mockDispatchOne.mockResolvedValue({ hash: 'tx-hash-1', status: 'success' })
  })

  describe('1. Tranche schedule generation & activation wiring', () => {
    it('splits total reward into 3 tranches at {0, 30d, 90d} with exact Decimal sum', () => {
      const tranches = buildVestingTrancheSchedule({
        conversionId: 'conv-1',
        activatedAt: baseDate,
        ownerRewardTotal: 10, // 3.33333333 + 3.33333333 + 3.33333334 = 10
        referredRewardTotal: 5, // 1.66666666 + 1.66666666 + 1.66666668 = 5
        requiresBalanceAtLeast: 10,
        trancheCount: 3,
        scheduleDays: [0, 30, 90],
      })

      expect(tranches).toHaveLength(6)
      const referrerTranches = tranches.filter((t) => t.leg === 'referrer')
      const referredTranches = tranches.filter((t) => t.leg === 'referred')

      const referrerSum = referrerTranches.reduce(
        (acc, t) => acc.plus(t.amount),
        new Decimal(0)
      )
      const referredSum = referredTranches.reduce(
        (acc, t) => acc.plus(t.amount),
        new Decimal(0)
      )

      expect(referrerSum.toString()).toBe('10')
      expect(referredSum.toString()).toBe('5')
      expect(referrerTranches.map((t) => t.seq)).toEqual([1, 2, 3])
      expect(referrerTranches[0].vestsAt.toISOString()).toBe(
        '2026-10-27T00:00:00.000Z'
      )
      expect(referrerTranches[1].vestsAt.toISOString()).toBe(
        '2026-11-26T00:00:00.000Z'
      )
      expect(referrerTranches[2].vestsAt.toISOString()).toBe(
        '2027-01-25T00:00:00.000Z'
      )
    })

    it('creates vesting tranches on checkAndActivateOnDeposit', async () => {
      mockDb.referralConversion.findUnique.mockResolvedValue({
        id: 'conv-act-1',
        status: 'PENDING',
        referralCode: { ownerUserId: 'owner-1' },
      })

      await checkAndActivateOnDeposit(
        'referred-1',
        'tx-dep-1',
        '50',
        mockDb
      )

      expect(mockDb.referralRewardTranche.createMany).toHaveBeenCalledTimes(1)
      const createManyArg =
        mockDb.referralRewardTranche.createMany.mock.calls[0][0]
      expect(createManyArg.data).toHaveLength(6)
      expect(createManyArg.skipDuplicates).toBe(true)
    })
  })

  describe('2. Consecutive-snapshot balance checkpoint guard (M = 3)', () => {
    it('does NOT forfeit when a transient 1-snapshot dip occurs during rebalance', async () => {
      // Newest snapshot is $100, 1 hour ago dipped to $0 during rebalance, 2 hours ago was $100
      mockDb.yieldSnapshot.findMany.mockResolvedValue([
        {
          timestamp: new Date('2026-10-27T03:00:00.000Z'),
          principalAmount: new Decimal(100),
          yieldAmount: new Decimal(0),
        },
        {
          timestamp: new Date('2026-10-27T02:00:00.000Z'),
          principalAmount: new Decimal(0),
          yieldAmount: new Decimal(0),
        },
        {
          timestamp: new Date('2026-10-27T01:00:00.000Z'),
          principalAmount: new Decimal(100),
          yieldAmount: new Decimal(0),
        },
      ])

      const res = await evaluateReferredBalanceCheckpoint({
        referredUserId: 'referred-1',
        requiresBalanceAtLeast: 10,
        vestsAt: new Date('2026-10-27T03:00:00.000Z'),
        requiredConsecutiveSnapshots: 3,
        database: mockDb,
      })

      expect(res.meetsThreshold).toBe(true)
      expect(res.sustainedDrop).toBe(false)
    })

    it('vests when referred user withdraws then re-deposits before vestsAt', async () => {
      // Latest snapshot at vestsAt is >= $10 (re-deposited), even though older snapshots were $0
      mockDb.yieldSnapshot.findMany.mockResolvedValue([
        {
          timestamp: new Date('2026-11-26T00:00:00.000Z'),
          principalAmount: new Decimal(25),
          yieldAmount: new Decimal(0),
        },
        {
          timestamp: new Date('2026-11-25T23:00:00.000Z'),
          principalAmount: new Decimal(0),
          yieldAmount: new Decimal(0),
        },
        {
          timestamp: new Date('2026-11-25T22:00:00.000Z'),
          principalAmount: new Decimal(0),
          yieldAmount: new Decimal(0),
        },
      ])

      const res = await evaluateReferredBalanceCheckpoint({
        referredUserId: 'referred-1',
        requiresBalanceAtLeast: 10,
        vestsAt: new Date('2026-11-26T00:00:00.000Z'),
        requiredConsecutiveSnapshots: 3,
        database: mockDb,
      })

      expect(res.meetsThreshold).toBe(true)
      expect(res.consecutiveBelowCount).toBe(0)
    })

    it('marks sustained drop when M = 3 consecutive snapshots are below threshold', async () => {
      mockDb.yieldSnapshot.findMany.mockResolvedValue([
        {
          timestamp: new Date('2026-11-26T00:00:00.000Z'),
          principalAmount: new Decimal(2),
          yieldAmount: new Decimal(0),
        },
        {
          timestamp: new Date('2026-11-25T23:00:00.000Z'),
          principalAmount: new Decimal(2),
          yieldAmount: new Decimal(0),
        },
        {
          timestamp: new Date('2026-11-25T22:00:00.000Z'),
          principalAmount: new Decimal(0),
          yieldAmount: new Decimal(0),
        },
      ])

      const res = await evaluateReferredBalanceCheckpoint({
        referredUserId: 'referred-1',
        requiresBalanceAtLeast: 10,
        vestsAt: new Date('2026-11-26T00:00:00.000Z'),
        requiredConsecutiveSnapshots: 3,
        database: mockDb,
      })

      expect(res.meetsThreshold).toBe(false)
      expect(res.sustainedDrop).toBe(true)
      expect(res.consecutiveBelowCount).toBe(3)
    })
  })

  describe('3. Vesting sweep, per-tranche outbox payout, and terminal REWARDED transition', () => {
    it('pays due tranches when balance holds, keeps conversion ACTIVATED while future tranches remain, and advances to REWARDED only when all tranches are terminal', async () => {
      const tranche1Ref = {
        id: 't-ref-1',
        conversionId: 'conv-1',
        leg: 'referrer',
        seq: 1,
        amount: new Decimal('2'),
        vestsAt: new Date(baseDate.getTime() - 1000),
        status: 'PENDING',
        requiresBalanceAtLeast: new Decimal('10'),
      }
      const tranche2Ref = {
        id: 't-ref-2',
        conversionId: 'conv-1',
        leg: 'referrer',
        seq: 2,
        amount: new Decimal('3'),
        vestsAt: new Date(baseDate.getTime() + 30 * 86_400_000),
        status: 'PENDING',
        requiresBalanceAtLeast: new Decimal('10'),
      }

      mockDb.position.findMany.mockResolvedValue([
        { depositedAmount: new Decimal(50), yieldEarned: new Decimal(1) },
      ])
      mockDb.referralConversion.findMany.mockResolvedValueOnce([
        {
          id: 'conv-1',
          referredUserId: 'referred-1',
          status: 'ACTIVATED',
          manualReviewRequired: false,
          manualReviewRejected: false,
          referralCode: { ownerUserId: 'owner-1' },
          tranches: [tranche1Ref, tranche2Ref],
        },
      ])
      // After tranche 1 is paid, tranche 2 is still PENDING
      mockDb.referralRewardTranche.findMany.mockResolvedValueOnce([
        { ...tranche1Ref, status: 'VESTED_PAID' },
        tranche2Ref,
      ])

      const sweep1 = await sweepVestingTranchesAndClawbacks(baseDate, mockDb)
      expect(sweep1.tranchesPaid).toBe(1)
      expect(sweep1.conversionsRewarded).toBe(0)
      expect(mockDispatchOne).toHaveBeenCalledTimes(1)
      expect(mockDb.referralRewardTranche.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 't-ref-1' },
          data: expect.objectContaining({
            status: 'VESTED_PAID',
            paidTxHash: 'tx-hash-1',
          }),
        })
      )

      // Now advance clock past tranche 2's vestsAt; all tranches become terminal -> REWARDED
      const futureDate = new Date(baseDate.getTime() + 31 * 86_400_000)
      mockDb.referralConversion.findMany.mockResolvedValueOnce([
        {
          id: 'conv-1',
          referredUserId: 'referred-1',
          status: 'ACTIVATED',
          manualReviewRequired: false,
          manualReviewRejected: false,
          referralCode: { ownerUserId: 'owner-1' },
          tranches: [{ ...tranche1Ref, status: 'VESTED_PAID' }, tranche2Ref],
        },
      ])
      mockDb.referralRewardTranche.findMany.mockResolvedValueOnce([
        { ...tranche1Ref, status: 'VESTED_PAID' },
        { ...tranche2Ref, status: 'VESTED_PAID' },
      ])

      const sweep2 = await sweepVestingTranchesAndClawbacks(futureDate, mockDb)
      expect(sweep2.tranchesPaid).toBe(1)
      expect(sweep2.conversionsRewarded).toBe(1)
      expect(mockDb.referralConversion.update).toHaveBeenCalledWith({
        where: { id: 'conv-1' },
        data: { status: 'REWARDED', payoutError: null },
      })
    })

    it('leaves tranche PENDING with payoutError when on-chain dispatch fails (never marked paid without confirmed paidTxHash)', async () => {
      const tranche1 = {
        id: 't-fail-1',
        conversionId: 'conv-fail',
        leg: 'referrer',
        seq: 1,
        amount: new Decimal('2'),
        vestsAt: new Date(baseDate.getTime() - 1000),
        status: 'PENDING',
        requiresBalanceAtLeast: new Decimal('10'),
      }
      mockDb.position.findMany.mockResolvedValue([
        { depositedAmount: new Decimal(50), yieldEarned: new Decimal(0) },
      ])
      mockDispatchOne.mockRejectedValueOnce(new Error('horizon timeout'))
      mockDb.referralConversion.findMany.mockResolvedValueOnce([
        {
          id: 'conv-fail',
          referredUserId: 'referred-1',
          status: 'ACTIVATED',
          manualReviewRequired: false,
          manualReviewRejected: false,
          referralCode: { ownerUserId: 'owner-1' },
          tranches: [tranche1],
        },
      ])
      mockDb.referralRewardTranche.findMany.mockResolvedValueOnce([tranche1])

      const res = await sweepVestingTranchesAndClawbacks(baseDate, mockDb)
      expect(res.tranchesPaid).toBe(0)
      expect(res.conversionsRewarded).toBe(0)
      expect(mockDb.referralRewardTranche.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 't-fail-1' },
          data: expect.objectContaining({
            payoutError: expect.stringContaining('horizon timeout'),
          }),
        })
      )
    })
  })

  describe('4. Early-withdrawal clawback, future reward offset, cap, and write-off', () => {
    it('claws back already-paid tranche 1, forfeits remaining tranches, and offsets against future referral rewards', async () => {
      const paidTranche1 = {
        id: 't-1',
        conversionId: 'conv-early',
        leg: 'referrer',
        seq: 1,
        amount: new Decimal('5'),
        vestsAt: new Date(baseDate.getTime() - 10 * 86_400_000),
        status: 'VESTED_PAID',
        requiresBalanceAtLeast: new Decimal('10'),
      }
      const pendingTranche2 = {
        id: 't-2',
        conversionId: 'conv-early',
        leg: 'referrer',
        seq: 2,
        amount: new Decimal('5'),
        vestsAt: new Date(baseDate.getTime() + 20 * 86_400_000),
        status: 'PENDING',
        requiresBalanceAtLeast: new Decimal('10'),
      }

      mockDb.referralRewardTranche.findMany.mockResolvedValueOnce([
        paidTranche1,
        pendingTranche2,
      ])

      const cbRes = await recordEarlyWithdrawalClawback({
        conversionId: 'conv-early',
        referrerUserId: 'owner-1',
        reason: 'EARLY_WITHDRAWAL_BEFORE_VESTING_END',
        now: baseDate,
        database: mockDb,
      })

      expect(cbRes.clawbackCreated).toBe(true)
      expect(cbRes.clawedBackAmount).toBe(5)
      expect(cbRes.forfeitedTrancheCount).toBe(1)
      expect(mockPublishUserEvent).toHaveBeenCalledWith(
        'owner-1',
        'alerts',
        'referral.tranche_forfeited',
        expect.objectContaining({
          conversionId: 'conv-early',
          trancheId: 't-2',
        })
      )
      expect(mockPublishUserEvent).toHaveBeenCalledWith(
        'owner-1',
        'alerts',
        'referral.clawback_recorded',
        expect.objectContaining({
          conversionId: 'conv-early',
          originalAmount: 5,
        })
      )
      expect(mockDb.auditPayloadHash.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            kind: 'REFERRAL_CLAWBACK_CREATED',
          }),
        })
      )

      // Now offset a future $8 referrer reward against the $5 OPEN clawback
      mockDb.referralClawback.findMany
        .mockResolvedValueOnce([]) // expireStaleClawbacks
        .mockResolvedValueOnce([
          {
            id: 'cb-1',
            referrerUserId: 'owner-1',
            conversionId: 'conv-early',
            originalAmount: new Decimal('5'),
            remainingAmount: new Decimal('5'),
            offsetApplied: new Decimal('0'),
            status: 'OPEN',
            expiresAt: new Date(baseDate.getTime() + 60 * 86_400_000),
          },
        ])

      const offsetRes = await applyClawbackOffsetToReward({
        referrerUserId: 'owner-1',
        grossRewardAmount: 8,
        conversionId: 'conv-new',
        trancheId: 't-new-1',
        now: baseDate,
        database: mockDb,
      })

      expect(offsetRes.offsetAmount).toBe(5)
      expect(offsetRes.netPayableAmount).toBe(3)
      expect(mockDb.referralClawback.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'cb-1' },
          data: expect.objectContaining({
            status: 'OFFSET_COMPLETE',
          }),
        })
      )
    })

    it('caps open clawback at CLAWBACK_MAX_PER_REFERRER ($200) and writes off expired clawbacks after 90d', async () => {
      mockDb.referralRewardTranche.findMany.mockResolvedValueOnce([
        {
          id: 't-big-1',
          conversionId: 'conv-big',
          leg: 'referrer',
          seq: 1,
          amount: new Decimal('60'),
          status: 'VESTED_PAID',
          requiresBalanceAtLeast: new Decimal('10'),
        },
      ])
      // Referrer already has $180 in OPEN clawbacks -> only $20 room left under $200 cap
      mockDb.referralClawback.findMany.mockResolvedValueOnce([
        { remainingAmount: new Decimal('180') },
      ])

      const cbRes = await recordEarlyWithdrawalClawback({
        conversionId: 'conv-big',
        referrerUserId: 'owner-1',
        reason: 'EARLY_WITHDRAWAL_BEFORE_VESTING_END',
        now: baseDate,
        database: mockDb,
      })

      expect(cbRes.clawedBackAmount).toBe(20)
      expect(cbRes.writtenOffAmount).toBe(40)

      // Expire stale clawbacks past expiresAt
      mockDb.referralClawback.findMany.mockResolvedValueOnce([
        {
          id: 'cb-stale',
          referrerUserId: 'owner-1',
          conversionId: 'conv-old',
          remainingAmount: new Decimal('20'),
          writtenOffAmount: new Decimal('0'),
          status: 'OPEN',
          expiresAt: new Date(baseDate.getTime() - 1000),
        },
      ])
      const expiredCount = await expireStaleClawbacks(baseDate, mockDb)
      expect(expiredCount).toBe(1)
      expect(mockDb.referralClawback.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'cb-stale' },
          data: expect.objectContaining({
            status: 'WRITTEN_OFF',
          }),
        })
      )
    })

    it('surfaces vesting schedule, disclosure copy, and clawback summary on getReferralMeSummary without exposing referred user balance', async () => {
      mockDb.referralCode.findUnique.mockResolvedValue({
        code: 'VESTCODE',
        ownerUserId: 'owner-1',
        conversions: [
          {
            id: 'conv-1',
            status: 'ACTIVATED',
            activatedAt: baseDate,
            createdAt: baseDate,
            tranches: [
              {
                id: 'tr-1',
                leg: 'referrer',
                seq: 1,
                amount: new Decimal('1.66666666'),
                vestsAt: baseDate,
                status: 'VESTED_PAID',
                paidTxHash: 'hash-1',
                evaluatedAt: baseDate,
              },
              {
                id: 'tr-2',
                leg: 'referrer',
                seq: 2,
                amount: new Decimal('1.66666666'),
                vestsAt: new Date(baseDate.getTime() + 30 * 86_400_000),
                status: 'PENDING',
              },
            ],
            clawbacks: [],
          },
        ],
      })
      mockDb.referralClawback.findMany.mockResolvedValue([])

      const summary = await getReferralMeSummary('owner-1', mockDb)
      expect(summary.code).toBe('VESTCODE')
      expect(summary.disclosure).toBe(REFERRAL_VESTING_DISCLOSURE_COPY)
      expect(summary.conversions[0].nextVestAt).toBe(
        new Date(baseDate.getTime() + 30 * 86_400_000).toISOString()
      )
      expect(summary.conversions[0].tranches).toHaveLength(2)
      expect(
        JSON.stringify(summary.conversions[0])
      ).not.toContain('principalAmount')
      expect(
        JSON.stringify(summary.conversions[0])
      ).not.toContain('depositedAmount')

      // Verify payoutActivatedConversions delegates cleanly when tranche model is present
      mockDb.referralConversion.findMany.mockResolvedValueOnce([])
      const sweepRes = await payoutActivatedConversions()
      expect(sweepRes).toEqual({ scanned: 0, rewarded: 0 })
    })
  })
})
