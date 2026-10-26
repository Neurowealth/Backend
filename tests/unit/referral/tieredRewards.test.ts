import db from '../../../src/db'
import { getWalletByUserId } from '../../../src/stellar/wallet'
import {
  DEFAULT_REFERRAL_SCHEDULE,
  calculateTieredReferralReward,
  resolveDepositTier,
  resolveMilestoneTier,
} from '../../../src/referral/schedule'
import {
  attributeSignup,
  checkAndActivateOnDeposit,
  payoutActivatedConversions,
  getReferralMeSummary,
  decideAbuseReviewConversion,
  listAbuseReviewQueue,
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

describe('Tiered Referral Rewards & Lifecycle (#363)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockDb.referralRewardSchedule = {
      findFirst: jest.fn().mockResolvedValue(null),
    }
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
    mockDb.user = {
      findUnique: jest.fn().mockResolvedValue({ network: 'MAINNET' }),
    }
    mockDb.transaction = {
      create: jest.fn().mockImplementation(({ data }: any) => ({
        id: `tx-${data.userId}`,
      })),
      update: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockImplementation(({ where }: any) => {
        if (where?.id?.in) {
          return Promise.resolve(
            where.id.in.map((id: string) => ({ id, status: 'CONFIRMED' }))
          )
        }
        return Promise.resolve([])
      }),
    }
    mockDb.session = {
      findMany: jest.fn().mockResolvedValue([]),
    }
    mockDb.fiatPurchasePlan = {
      findMany: jest.fn().mockResolvedValue([]),
    }
    mockDb.auditPayloadHash = {
      create: jest.fn().mockResolvedValue({ id: 'audit-1' }),
    }
    mockDb.$transaction = jest.fn((fn: (tx: any) => unknown) => fn(mockDb))
    mockGetWallet.mockResolvedValue({ publicKey: 'GADDRESS123' })
    mockEnqueueOutboxOp.mockResolvedValue({ id: 'op-1' })
    mockDispatchOne.mockResolvedValue({ hash: 'tx-hash', status: 'success' })
  })

  describe('Pure schedule & cap calculations', () => {
    it('resolves deposit tiers across $10-$99, $100-$499, $500-$2499, and $2500+', () => {
      expect(
        resolveDepositTier(25, DEFAULT_REFERRAL_SCHEDULE.depositTiers)
      ).toMatchObject({ ownerReward: 5, referredReward: 5 })
      expect(
        resolveDepositTier(250, DEFAULT_REFERRAL_SCHEDULE.depositTiers)
      ).toMatchObject({ ownerReward: 15, referredReward: 10 })
      expect(
        resolveDepositTier(1000, DEFAULT_REFERRAL_SCHEDULE.depositTiers)
      ).toMatchObject({ ownerReward: 40, referredReward: 25 })
      expect(
        resolveDepositTier(5000, DEFAULT_REFERRAL_SCHEDULE.depositTiers)
      ).toMatchObject({ ownerReward: 100, referredReward: 50 })
    })

    it('applies Bronze (1x), Silver (1.25x), and Gold (1.5x) milestone multipliers', () => {
      expect(
        resolveMilestoneTier(3, DEFAULT_REFERRAL_SCHEDULE.milestoneTiers)
          .currentTier
      ).toMatchObject({ tier: 1, label: 'Bronze', multiplier: 1.0 })
      expect(
        resolveMilestoneTier(5, DEFAULT_REFERRAL_SCHEDULE.milestoneTiers)
          .currentTier
      ).toMatchObject({ tier: 2, label: 'Silver', multiplier: 1.25 })
      expect(
        resolveMilestoneTier(20, DEFAULT_REFERRAL_SCHEDULE.milestoneTiers)
          .currentTier
      ).toMatchObject({ tier: 3, label: 'Gold', multiplier: 1.5 })

      const calc = calculateTieredReferralReward({
        qualifyingDepositAmount: 500, // base $40 owner / $25 referred
        activatedConversionsCount: 5, // Silver 1.25x -> $50 owner
        earnedThisMonth: 0,
        schedule: DEFAULT_REFERRAL_SCHEDULE,
      })
      expect(calc.calculatedOwnerReward).toBe(50)
      expect(calc.calculatedReferredReward).toBe(25)
      expect(calc.referrerMilestoneTier).toBe('Silver')
      expect(calc.rewardCapped).toBe(false)
    })

    it('enforces per-conversion cap and monthly referrer cap', () => {
      // Custom schedule where base * 1.5 exceeds per-conversion cap of $120
      const customSchedule = {
        ...DEFAULT_REFERRAL_SCHEDULE,
        maxRewardPerConversion: 120,
        maxRewardPerReferrerPerMonth: 1000,
      }
      const perConvCapped = calculateTieredReferralReward({
        qualifyingDepositAmount: 3000, // $100 * 1.5 = $150 -> clamped to $120
        activatedConversionsCount: 22,
        earnedThisMonth: 100,
        schedule: customSchedule,
      })
      expect(perConvCapped.calculatedOwnerReward).toBe(120)
      expect(perConvCapped.rewardCapped).toBe(true)
      expect(perConvCapped.capReason).toBe('PER_CONVERSION_CAP')

      // Monthly cap clamp: referrer has already earned $980 of $1000 cap
      const monthlyCapped = calculateTieredReferralReward({
        qualifyingDepositAmount: 500, // $40 base -> clamped to $20 remaining
        activatedConversionsCount: 2,
        earnedThisMonth: 980,
        schedule: DEFAULT_REFERRAL_SCHEDULE,
      })
      expect(monthlyCapped.calculatedOwnerReward).toBe(20)
      expect(monthlyCapped.calculatedReferredReward).toBe(25)
      expect(monthlyCapped.rewardCapped).toBe(true)
      expect(monthlyCapped.capReason).toBe('MONTHLY_CAP')
    })
  })

  describe('End-to-end activation, hold window, Sybil gating, and admin override', () => {
    it('blocks circular referrals at signup attribution', async () => {
      mockDb.referralCode.findUnique.mockResolvedValue({
        id: 'rc-b',
        ownerUserId: 'user-b',
      })
      // user-b was referred by user-a, so user-a signing up with user-b's code is a cycle
      mockDb.referralConversion.findUnique.mockResolvedValue({
        id: 'conv-ab',
        referredUserId: 'user-b',
        referralCode: { ownerUserId: 'user-a' },
      })

      const id = await attributeSignup('user-a', 'CODEBBBB', mockDb)
      expect(id).toBeNull()
      expect(mockDb.referralConversion.create).not.toHaveBeenCalled()
    })

    it('activates clean deposit at the right tier and pays out only after holdUntil expires', async () => {
      mockDb.referralConversion.findUnique.mockResolvedValue({
        id: 'conv-1',
        referralCodeId: 'rc-1',
        referredUserId: 'referred-1',
        status: 'PENDING',
        referralCode: { id: 'rc-1', ownerUserId: 'owner-1' },
      })
      // 4 prior activations -> this is the 5th (Silver 1.25x)
      mockDb.referralConversion.findMany.mockResolvedValueOnce([
        { activatedAt: new Date(), calculatedOwnerReward: 5 },
        { activatedAt: new Date(), calculatedOwnerReward: 5 },
        { activatedAt: new Date(), calculatedOwnerReward: 5 },
        { activatedAt: new Date(), calculatedOwnerReward: 5 },
      ])

      await checkAndActivateOnDeposit('referred-1', 'tx-dep-1', '600', mockDb)

      const updateArg = mockDb.referralConversion.update.mock.calls[0][0]
      expect(updateArg.data.status).toBe('ACTIVATED')
      expect(updateArg.data.scheduleVersion).toBe('v1')
      expect(updateArg.data.referrerMilestoneTier).toBe('Silver')
      expect(Number(updateArg.data.calculatedOwnerReward)).toBe(50) // $40 * 1.25
      expect(Number(updateArg.data.calculatedReferredReward)).toBe(25)
      expect(updateArg.data.payoutHold).toBe('NONE')
      expect(updateArg.data.holdUntil).toBeInstanceOf(Date)

      // 1) Sweep BEFORE holdUntil -> skipped
      mockDb.referralConversion.findMany.mockResolvedValueOnce([
        {
          id: 'conv-1',
          referredUserId: 'referred-1',
          status: 'ACTIVATED',
          payoutHold: 'NONE',
          abuseRiskScore: 0,
          holdUntil: new Date(Date.now() + 3600_000),
          qualifyingDepositAmount: 600,
          calculatedOwnerReward: 50,
          calculatedReferredReward: 25,
          ownerRewardTxId: null,
          referredRewardTxId: null,
          referralCode: { ownerUserId: 'owner-1' },
        },
      ])
      const earlySweep = await payoutActivatedConversions()
      expect(earlySweep.rewarded).toBe(0)
      expect(mockDispatchOne).not.toHaveBeenCalled()

      // 2) Sweep AFTER holdUntil -> pays $50 owner and $25 referred
      mockDb.referralConversion.findMany.mockResolvedValueOnce([
        {
          id: 'conv-1',
          referredUserId: 'referred-1',
          status: 'ACTIVATED',
          payoutHold: 'NONE',
          abuseRiskScore: 0,
          holdUntil: new Date(Date.now() - 1000),
          qualifyingDepositAmount: 600,
          calculatedOwnerReward: 50,
          calculatedReferredReward: 25,
          ownerRewardTxId: null,
          referredRewardTxId: null,
          referralCode: { ownerUserId: 'owner-1' },
        },
      ])
      const readySweep = await payoutActivatedConversions()
      expect(readySweep.rewarded).toBe(1)
      expect(mockDispatchOne).toHaveBeenCalledTimes(2)
      expect(Number(mockDb.transaction.create.mock.calls[0][0].data.amount)).toBe(
        50
      )
      expect(Number(mockDb.transaction.create.mock.calls[1][0].data.amount)).toBe(
        25
      )
    })

    it('flags a self-funded deposit into AUTO_REVIEW and skips it in payout job', async () => {
      mockDb.referralConversion.findUnique.mockResolvedValue({
        id: 'conv-sf',
        referralCodeId: 'rc-1',
        referredUserId: 'referred-1',
        status: 'PENDING',
        referralCode: { id: 'rc-1', ownerUserId: 'owner-1' },
      })
      mockDb.user.findUnique.mockImplementation(({ where }: any) =>
        Promise.resolve({
          walletAddress: where.id === 'owner-1' ? 'GOWNER' : 'GREFERRED',
        })
      )
      mockDb.transaction.findMany.mockImplementation(({ where }: any) => {
        if (where.userId === 'owner-1' && where.type === 'WITHDRAWAL') {
          return Promise.resolve([
            { id: 'w-1', amount: 100, memo: 'GREFERRED' },
          ])
        }
        if (where.userId === 'referred-1' && where.type === 'DEPOSIT') {
          return Promise.resolve([{ id: 'd-1', amount: 100, memo: 'GOWNER' }])
        }
        return Promise.resolve([])
      })

      await checkAndActivateOnDeposit('referred-1', 'tx-sf', '100', mockDb)

      const updateArg = mockDb.referralConversion.update.mock.calls[0][0]
      expect(updateArg.data.payoutHold).toBe('AUTO_REVIEW')
      expect(updateArg.data.abuseReasons).toContain('self_funding_chain')

      // Payout job skips conversions in AUTO_REVIEW
      mockDb.referralConversion.findMany.mockResolvedValueOnce([
        {
          id: 'conv-sf',
          referredUserId: 'referred-1',
          status: 'ACTIVATED',
          payoutHold: 'AUTO_REVIEW',
          abuseRiskScore: 50,
          holdUntil: new Date(Date.now() - 1000),
          referralCode: { ownerUserId: 'owner-1' },
        },
      ])
      const sweep = await payoutActivatedConversions()
      expect(sweep.rewarded).toBe(0)
      expect(mockDispatchOne).not.toHaveBeenCalled()
    })

    it('escalates to AUTO_REVIEW at payout time when >= 80% deposit is withdrawn during hold window', async () => {
      mockDb.referralConversion.findMany.mockResolvedValueOnce([
        {
          id: 'conv-dtw',
          referredUserId: 'referred-1',
          status: 'ACTIVATED',
          activatedAt: new Date(Date.now() - 25 * 3600_000),
          payoutHold: 'NONE',
          abuseRiskScore: 0,
          abuseReasons: [],
          holdUntil: new Date(Date.now() - 1000),
          qualifyingDepositAmount: 200,
          calculatedOwnerReward: 15,
          calculatedReferredReward: 10,
          ownerRewardTxId: null,
          referredRewardTxId: null,
          referralCode: { ownerUserId: 'owner-1' },
        },
      ])
      // 85% ($170 of $200) withdrawn during hold window
      mockDb.transaction.findMany.mockImplementation(({ where }: any) => {
        if (where.type === 'WITHDRAWAL') {
          return Promise.resolve([{ amount: 170 }])
        }
        return Promise.resolve([])
      })

      const sweep = await payoutActivatedConversions()
      expect(sweep.rewarded).toBe(0)
      expect(mockDispatchOne).not.toHaveBeenCalled()

      const holdUpdate = mockDb.referralConversion.update.mock.calls[0][0]
      expect(holdUpdate.data.payoutHold).toBe('AUTO_REVIEW')
      expect(holdUpdate.data.abuseReasons).toContain('deposit_then_withdraw')
    })

    it('fails closed when abuseRiskScore is null at payout time', async () => {
      mockDb.referralConversion.findMany.mockResolvedValueOnce([
        {
          id: 'conv-null-score',
          referredUserId: 'referred-1',
          status: 'ACTIVATED',
          payoutHold: 'NONE',
          abuseRiskScore: null,
          holdUntil: new Date(Date.now() - 1000),
          referralCode: { ownerUserId: 'owner-1' },
        },
      ])

      const sweep = await payoutActivatedConversions()
      expect(sweep.rewarded).toBe(0)
      expect(mockDispatchOne).not.toHaveBeenCalled()
      expect(mockDb.referralConversion.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'conv-null-score' },
          data: expect.objectContaining({ payoutHold: 'AUTO_REVIEW' }),
        })
      )
    })

    it('records admin RELEASE decision with #315 AuditPayloadHash and unblocks payout', async () => {
      mockDb.referralConversion.findUnique.mockResolvedValue({
        id: 'conv-review-1',
        status: 'ACTIVATED',
        payoutHold: 'AUTO_REVIEW',
        abuseRiskScore: 50,
        abuseReasons: ['self_funding_chain'],
        activatedAt: new Date(Date.now() - 48 * 3600_000),
      })

      const decisionRes = await decideAbuseReviewConversion(
        {
          conversionId: 'conv-review-1',
          decision: 'RELEASE',
          reason: 'Verified legitimate family transfer',
          reviewerId: 'ops-admin-1',
        },
        mockDb
      )

      expect(decisionRes.payoutHold).toBe('NONE')
      expect(decisionRes.payloadHash).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(mockDb.auditPayloadHash.create).toHaveBeenCalledWith({
        data: {
          tableName: 'referral_conversions',
          kind: 'REFERRAL_REVIEW_DECISION',
          payloadHash: decisionRes.payloadHash,
        },
      })

      // List review queue works
      mockDb.referralConversion.findMany.mockResolvedValueOnce([
        {
          id: 'conv-review-2',
          referredUserId: 'referred-2',
          payoutHold: 'AUTO_REVIEW',
          abuseRiskScore: 45,
          abuseReasons: ['burst_activations'],
          qualifyingDepositAmount: 100,
          referralCode: { ownerUserId: 'owner-1' },
        },
      ])
      const queue = await listAbuseReviewQueue(mockDb)
      expect(queue).toHaveLength(1)
      expect(queue[0].abuseReasons).toContain('burst_activations')
    })

    it('redacts DENIED conversions in getReferralMeSummary as NOT_ELIGIBLE without leaking abuse reasons', async () => {
      mockDb.referralCode.findUnique.mockResolvedValue({
        code: 'MYCODE88',
        ownerUserId: 'owner-1',
        conversions: [
          {
            id: 'conv-denied',
            status: 'ACTIVATED',
            payoutHold: 'DENIED',
            abuseRiskScore: 95,
            abuseReasons: ['circular_referral', 'self_funding_chain'],
            calculatedOwnerReward: 40,
            calculatedReferredReward: 25,
            createdAt: new Date(),
          },
          {
            id: 'conv-held',
            status: 'ACTIVATED',
            payoutHold: 'NONE',
            abuseRiskScore: 0,
            abuseReasons: [],
            calculatedOwnerReward: 15,
            calculatedReferredReward: 10,
            holdUntil: new Date(Date.now() + 3600_000),
            activatedAt: new Date(),
            createdAt: new Date(),
          },
        ],
      })

      const summary = await getReferralMeSummary('owner-1', mockDb)
      expect(summary.code).toBe('MYCODE88')
      expect(summary.conversions).toHaveLength(2)

      const deniedItem = summary.conversions.find(
        (c: any) => c.id === 'conv-denied'
      )!
      expect(deniedItem.status).toBe('NOT_ELIGIBLE')
      expect(deniedItem.userFacingStatus).toBe('NOT_ELIGIBLE')
      expect(deniedItem.ownerReward).toBe(0)
      expect((deniedItem as any).abuseReasons).toBeUndefined()
      expect((deniedItem as any).abuseRiskScore).toBeUndefined()

      const heldItem = summary.conversions.find(
        (c: any) => c.id === 'conv-held'
      )!
      expect(heldItem.userFacingStatus).toBe('HOLD_WINDOW')
      expect(heldItem.holdRemainingSeconds).toBeGreaterThan(0)
    })
  })
})
