// #840 — approving a FLAGGED conversion must make it fully payout-eligible.
// Regression: approval used to mark ACTIVATED without creating vesting
// tranches, and the sweep skipped zero-tranche ACTIVATED rows forever.

import db from '../../../src/db'
import { getWalletByUserId } from '../../../src/stellar/wallet'
import {
  resolveFlaggedConversion,
  payoutActivatedConversions,
} from '../../../src/referral/service'
import { sweepVestingTranchesAndClawbacks } from '../../../src/referral/vesting'

jest.mock('../../../src/db', () => ({ __esModule: true, default: {} }))
jest.mock('../../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}))
jest.mock('../../../src/services/alerting', () => ({
  alertingService: { emit: jest.fn().mockResolvedValue({ sent: true }) },
}))
jest.mock('../../../src/stellar/wallet', () => ({
  getWalletByUserId: jest.fn(),
}))
jest.mock('../../../src/events/publisher', () => ({
  publishUserEvent: jest.fn().mockResolvedValue(undefined),
  EVENT_TYPE_TOPIC: {
    'referral.tranche_forfeited': 'alerts',
    'referral.tranche_paid': 'transactions',
  },
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

describe('FLAGGED approval pays out (#840)', () => {
  let tranches: any[]
  let conversion: any

  beforeEach(() => {
    jest.clearAllMocks()
    tranches = []
    conversion = {
      id: 'conv-1',
      status: 'FLAGGED',
      referredUserId: 'referred-1',
      calculatedOwnerReward: 3,
      calculatedReferredReward: 3,
      manualReviewRequired: false,
      manualReviewRejected: false,
      referralCode: { ownerUserId: 'owner-1' },
    }

    mockDb.$transaction = jest.fn((fn: (tx: any) => unknown) => fn(mockDb))
    mockDb.session = { findMany: jest.fn().mockResolvedValue([]) }
    mockDb.referralCode = { findUnique: jest.fn(), findFirst: jest.fn() }
    mockDb.referralConversion = {
      findUnique: jest.fn().mockImplementation(async () => conversion),
      // The sweep asks for tranche-backed conversions; the direct payout path
      // asks for zero-tranche ones. Keep those sets disjoint like Prisma does.
      findMany: jest.fn().mockImplementation(({ where }: any) => {
        if (conversion.status !== 'ACTIVATED') return []
        const wantsTranches = where?.tranches?.some ? true : false
        const hasTranches = tranches.length > 0
        if (wantsTranches !== hasTranches) return []
        return [
          {
            ...conversion,
            tranches: tranches.map((t) => ({ ...t })),
          },
        ]
      }),
      update: jest.fn().mockImplementation(({ where, data }: any) => {
        if (where?.id === conversion.id) {
          Object.assign(conversion, data)
        }
        return Promise.resolve({})
      }),
    }
    mockDb.referralRewardTranche = {
      createMany: jest.fn().mockImplementation(({ data }: any) => {
        data.forEach((tranche: any, index: number) => {
          tranches.push({
            ...tranche,
            id: `tranche-${index + 1}`,
            status: 'PENDING',
            amount: tranche.amount,
            requiresBalanceAtLeast: tranche.requiresBalanceAtLeast,
          })
        })
        return Promise.resolve({ count: data.length })
      }),
      findMany: jest
        .fn()
        .mockImplementation(({ where }: any) =>
          Promise.resolve(
            where?.conversionId
              ? tranches.filter((t) => t.conversionId === where.conversionId)
              : tranches
          )
        ),
      update: jest.fn().mockImplementation(({ where, data }: any) => {
        const tranche = tranches.find((t) => t.id === where.id)
        if (tranche) Object.assign(tranche, data)
        return Promise.resolve({})
      }),
    }
    mockDb.referralClawback = {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      update: jest.fn(),
    }
    mockDb.yieldSnapshot = { findMany: jest.fn().mockResolvedValue([]) }
    mockDb.position = {
      findMany: jest
        .fn()
        .mockResolvedValue([{ depositedAmount: 100, yieldEarned: 0 }]),
    }
    mockDb.user = {
      findUnique: jest.fn().mockResolvedValue({ network: 'MAINNET' }),
    }
    mockDb.transaction = {
      create: jest
        .fn()
        .mockImplementation(({ data }: any) => ({ id: `tx-${data.userId}` })),
      update: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    }
    mockDb.auditPayloadHash = {
      create: jest.fn().mockResolvedValue({ id: 'audit-1' }),
    }

    ;(getWalletByUserId as jest.Mock).mockResolvedValue({
      publicKey: 'GADDRESS123',
    })
    mockEnqueueOutboxOp.mockResolvedValue({ id: 'op-1' })
    mockDispatchOne.mockResolvedValue({
      hash: 'onchain-hash',
      status: 'success',
    })
  })

  it('creates the normal tranche schedule on approval and reaches REWARDED', async () => {
    await resolveFlaggedConversion('conv-1', 'approve', 'admin-1')

    const activationUpdate = mockDb.referralConversion.update.mock.calls.find(
      (call: any[]) => call[0]?.data?.status === 'ACTIVATED'
    )
    expect(activationUpdate).toBeDefined()
    expect(mockDb.referralRewardTranche.createMany).toHaveBeenCalledTimes(1)
    expect(tranches).toHaveLength(6)
    expect(
      tranches.every(
        (t) =>
          t.requiresBalanceAtLeast.toString() === '10' && t.status === 'PENDING'
      )
    ).toBe(true)

    // The conversion is now ACTIVATED with tranches: a normal payout sweep
    // must pay the due tranches and eventually mark the conversion REWARDED,
    // not skip it as before #840.
    const reward = await payoutActivatedConversions()

    expect(reward.scanned).toBe(1)
    expect(mockDispatchOne).toHaveBeenCalledTimes(2) // day-0 leg of each side
    // The direct path must still scan zero-tranche ACTIVATED rows even when
    // the vesting sweep handled some conversions (no early return).
    expect(mockDb.referralConversion.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tranches: { none: {} } }),
      })
    )

    const future = new Date(Date.now() + 200 * 86_400_000)
    const sweep = await sweepVestingTranchesAndClawbacks(future, mockDb)
    expect(sweep.conversionsRewarded).toBe(1)
    expect(mockDispatchOne).toHaveBeenCalledTimes(6)
    const rewardedUpdate = mockDb.referralConversion.update.mock.calls.find(
      (call: any[]) => call[0]?.data?.status === 'REWARDED'
    )
    expect(rewardedUpdate).toBeDefined()
    expect(tranches.every((t) => t.status === 'VESTED_PAID')).toBe(true)
  })

  it('is idempotent when an already-approved conversion is swept again', async () => {
    await resolveFlaggedConversion('conv-1', 'approve', 'admin-1')
    await sweepVestingTranchesAndClawbacks(
      new Date(Date.now() + 200 * 86_400_000),
      mockDb
    )
    mockDispatchOne.mockClear()

    const second = await sweepVestingTranchesAndClawbacks(
      new Date(Date.now() + 200 * 86_400_000),
      mockDb
    )

    expect(second.conversionsRewarded).toBe(0)
    expect(mockDispatchOne).not.toHaveBeenCalled()
  })
})
