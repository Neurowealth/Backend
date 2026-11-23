/**
 * #768 — regression of #446 for TARGET_ALLOCATION.
 *
 * router.ts and TargetAllocationStrategy read userStrategyPreferences[0] for
 * a whole batch, so two users whose target weights or exposure-cap settings
 * differ must never share one. This drives the REAL rebalanceCheckJob with
 * the router mocked to capture each batch, then runs every captured batch
 * through the REAL TargetAllocationStrategy to check that each user is
 * evaluated against their own targets.
 */
import type { UserStrategyPreferences } from '../../../src/agent/types'

const userA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const userB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const userC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

// --- Router: capture the batches the loop hands it --------------------------
const mockExecuteRebalanceIfNeeded = jest.fn().mockResolvedValue(null)
jest.mock('../../../src/agent/router', () => ({
  executeRebalanceIfNeeded: (...args: unknown[]) =>
    mockExecuteRebalanceIfNeeded(...args),
  logAgentAction: jest.fn().mockResolvedValue(undefined),
  getThresholds: () => ({ minimumImprovement: 0.5, maxGasPercent: 0.1 }),
}))

jest.mock('../../../src/stellar/contract', () => ({
  triggerRebalance: jest.fn(),
}))
jest.mock('../../../src/stellar/wallet', () => ({
  getKeypairForUser: jest.fn(),
  getWalletByUserId: jest.fn(),
}))
jest.mock('../../../src/agent/snapshotter', () => ({
  captureAllUserBalances: jest.fn().mockResolvedValue(undefined),
  cleanupOldSnapshots: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../../../src/agent/scanner', () => ({
  scanAllProtocols: jest.fn().mockResolvedValue([]),
}))
jest.mock('../../../src/services/webhookDispatcher', () => ({
  dispatchWebhookEvent: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../../../src/utils/twilio-client', () => ({
  sendWhatsAppMessage: jest.fn().mockResolvedValue('SM1'),
}))
jest.mock('../../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  logBackgroundJob: jest.fn(),
}))

jest.mock('../../../src/db', () => ({ __esModule: true, default: {} }))

jest.mock('../../../src/analytics/riskService', () => ({
  getPortfolioRisk: jest.fn().mockResolvedValue({
    metrics: { annualisedVolatility: null },
  }),
}))

import db from '../../../src/db'
import {
  rebalanceCheckJob,
  strategySettingsFingerprint,
} from '../../../src/agent/loop'
import { TargetAllocationStrategy } from '../../../src/agent/strategies'

const mockDb = db as any

/** A position row shaped as loop.ts's `include: { user: true }` produces it. */
function position(
  id: string,
  userId: string,
  user: Record<string, unknown> = {}
) {
  return {
    id,
    userId,
    protocolName: 'Blend',
    currentValue: { toString: () => '10000000000000000000000' },
    user: {
      id: userId,
      riskTolerance: 5,
      rebalanceStrategy: null,
      strategyConfig: null,
      ...user,
    },
  }
}

/** A TARGET_ALLOCATION user with the given weights and a shared ceiling. */
function targetUser(
  targetAllocations: Record<string, number>,
  extra: Record<string, unknown> = {},
  userFields: Record<string, unknown> = {}
) {
  return {
    rebalanceStrategy: 'TARGET_ALLOCATION',
    strategyConfig: { targetAllocations, riskCeiling: 55, ...extra },
    ...userFields,
  }
}

type Batch = {
  protocol: string
  positions: Array<{ id: string; userId: string }>
  preferences: UserStrategyPreferences[] | undefined
  batchKey: string
}

function capturedBatches(): Batch[] {
  return mockExecuteRebalanceIfNeeded.mock.calls.map(
    ([protocol, positions, , preferences, context]) => ({
      protocol,
      positions,
      preferences,
      batchKey: context.batchKey,
    })
  )
}

function batchFor(userId: string): Batch {
  const batch = capturedBatches().find((b) =>
    b.positions.some((p) => p.userId === userId)
  )
  if (!batch) throw new Error(`no batch for ${userId}`)
  return batch
}

/** Run a captured batch through the real strategy, as router.ts would. */
function evaluate(batch: Batch) {
  return new TargetAllocationStrategy().analyze({
    currentProtocol: batch.protocol,
    totalAmount: '10000000000000000000000',
    currentApy: 5.0,
    availableProtocols: [
      {
        name: 'Blend',
        apy: 5.0,
        assetSymbol: 'USDC',
        lastUpdated: new Date(),
        isAvailable: true,
      },
      {
        name: 'Luma',
        apy: 6.0,
        assetSymbol: 'USDC',
        lastUpdated: new Date(),
        isAvailable: true,
      },
    ],
    thresholds: { minimumImprovement: 0.5, maxGasPercent: 0.1 },
    userStrategyPreferences: batch.preferences!,
    riskCeiling: batch.preferences![0].riskCeiling,
    protocolRiskScores: { Blend: 80, Luma: 80 },
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  mockExecuteRebalanceIfNeeded.mockResolvedValue(null)
  mockDb.position = { findMany: jest.fn().mockResolvedValue([]) }
  mockDb.savingsGoal = { findMany: jest.fn().mockResolvedValue([]) }
  mockDb.strategyFollow = { findMany: jest.fn().mockResolvedValue([]) }
  mockDb.custodialWallet = {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
  }
  mockDb.agentCircuitBreaker = {
    findMany: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue({ id: 'bk' }),
    update: jest.fn().mockResolvedValue({ id: 'bk' }),
  }
  mockDb.protocolRate = {
    findFirst: jest.fn().mockResolvedValue({ fetchedAt: new Date() }),
  }
  mockDb.yieldSnapshot = { findMany: jest.fn().mockResolvedValue([]) }
  mockDb.rebalanceDecision = { groupBy: jest.fn().mockResolvedValue([]) }
})

describe('TARGET_ALLOCATION batching (#768)', () => {
  it('evaluates 80/20 and 20/80 users on the same protocol and ceiling against their own targets', async () => {
    mockDb.position.findMany.mockResolvedValue([
      position('pos-a', userA, targetUser({ Blend: 80, Luma: 20 })),
      position('pos-b', userB, targetUser({ Blend: 20, Luma: 80 })),
    ])

    await rebalanceCheckJob()

    expect(mockExecuteRebalanceIfNeeded).toHaveBeenCalledTimes(2)

    const batchA = batchFor(userA)
    const batchB = batchFor(userB)
    expect(batchA.batchKey).not.toBe(batchB.batchKey)
    expect(batchA.positions).toEqual([
      expect.objectContaining({ id: 'pos-a', userId: userA }),
    ])
    expect(batchB.positions).toEqual([
      expect.objectContaining({ id: 'pos-b', userId: userB }),
    ])
    expect(batchA.preferences).toEqual([
      expect.objectContaining({
        userId: userA,
        targetAllocations: { Blend: 80, Luma: 20 },
        riskCeiling: 55,
      }),
    ])
    expect(batchB.preferences).toEqual([
      expect.objectContaining({
        userId: userB,
        targetAllocations: { Blend: 20, Luma: 80 },
        riskCeiling: 55,
      }),
    ])

    // User A wants to stay mostly in Blend; user B wants to move to Luma.
    const decisionA = await evaluate(batchA)
    const decisionB = await evaluate(batchB)
    expect(decisionA.shouldRebalance).toBe(false)
    expect(decisionB.shouldRebalance).toBe(true)
    expect(decisionB.targetProtocol).toBe('Luma')
  })

  it('keeps users with the same targets in one batch, whatever key order they were stored in', async () => {
    mockDb.position.findMany.mockResolvedValue([
      position('pos-a', userA, targetUser({ Blend: 80, Luma: 20 })),
      position('pos-c', userC, targetUser({ Luma: 20, Blend: 80 })),
    ])

    await rebalanceCheckJob()

    expect(mockExecuteRebalanceIfNeeded).toHaveBeenCalledTimes(1)
    expect(capturedBatches()[0].preferences).toHaveLength(2)
  })

  it.each([
    [
      'per-protocol exposure caps',
      targetUser({ Blend: 80, Luma: 20 }, { exposureCaps: {} }),
      targetUser(
        { Blend: 80, Luma: 20 },
        { exposureCaps: { Blend: { maxFraction: 0.5 } } }
      ),
    ],
    [
      'default max fractions',
      targetUser({ Blend: 80, Luma: 20 }, { defaultMaxFraction: 0.9 }),
      targetUser({ Blend: 80, Luma: 20 }, { defaultMaxFraction: 0.4 }),
    ],
    [
      // The risk tolerance picks the default cap when no override is set.
      'risk tolerances',
      targetUser({ Blend: 80, Luma: 20 }, {}, { riskTolerance: 2 }),
      targetUser({ Blend: 80, Luma: 20 }, {}, { riskTolerance: 9 }),
    ],
  ])(
    'splits users whose %s differ',
    async (_setting, firstUser, secondUser) => {
      mockDb.position.findMany.mockResolvedValue([
        position('pos-a', userA, firstUser),
        position('pos-b', userB, secondUser),
      ])

      await rebalanceCheckJob()

      expect(mockExecuteRebalanceIfNeeded).toHaveBeenCalledTimes(2)
      expect(batchFor(userA).preferences).toHaveLength(1)
      expect(batchFor(userB).preferences).toHaveLength(1)
    }
  )

  it('leaves batches without strategy preferences exactly as before', async () => {
    mockDb.position.findMany.mockResolvedValue([
      position('pos-a', userA, { riskTolerance: 2 }),
      position('pos-b', userB, { riskTolerance: 9 }),
    ])

    await rebalanceCheckJob()

    expect(mockExecuteRebalanceIfNeeded).toHaveBeenCalledTimes(1)
    const [batch] = capturedBatches()
    expect(batch.preferences).toBeUndefined()
    expect(batch.batchKey).toBe('Blend:DEFAULT:none:none:nogoal:shared')
  })
})

describe('strategySettingsFingerprint (#768)', () => {
  it('ignores the order keys were stored in', () => {
    expect(
      strategySettingsFingerprint(
        {
          targetAllocations: { Blend: 80, Luma: 20 },
          exposureCaps: {
            Blend: { maxFraction: 0.5, maxAbsolute: '100' },
            Luma: { maxFraction: 0.3 },
          },
        },
        5
      )
    ).toBe(
      strategySettingsFingerprint(
        {
          targetAllocations: { Luma: 20, Blend: 80 },
          exposureCaps: {
            Luma: { maxFraction: 0.3 },
            Blend: { maxAbsolute: '100', maxFraction: 0.5 },
          },
        },
        5
      )
    )
  })

  it('changes when any setting the strategy reads changes', () => {
    const base = strategySettingsFingerprint(
      { targetAllocations: { Blend: 80, Luma: 20 } },
      5
    )

    expect(
      strategySettingsFingerprint(
        { targetAllocations: { Blend: 20, Luma: 80 } },
        5
      )
    ).not.toBe(base)
    expect(
      strategySettingsFingerprint(
        {
          targetAllocations: { Blend: 80, Luma: 20 },
          exposureCaps: { Blend: { maxFraction: 0.5 } },
        },
        5
      )
    ).not.toBe(base)
    expect(
      strategySettingsFingerprint(
        { targetAllocations: { Blend: 80, Luma: 20 }, defaultMaxFraction: 0.4 },
        5
      )
    ).not.toBe(base)
    expect(
      strategySettingsFingerprint(
        { targetAllocations: { Blend: 80, Luma: 20 } },
        8
      )
    ).not.toBe(base)
  })
})
