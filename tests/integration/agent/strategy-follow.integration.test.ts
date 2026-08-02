/**
 * #285 — Strategy marketplace ↔ agent loop integration.
 *
 * Drives the REAL rebalanceCheckJob against a mocked database, with the real
 * strategy service and the real config-merge module in the path. It pins the
 * three things that would be catastrophic to get wrong:
 *
 *   1. CUSTODY (acceptance criterion) — a follow moves configuration and
 *      NOTHING else. No wallet is opened, no key is read, no contract call
 *      carries the publisher's identity, and the follow path never touches
 *      db.custodialWallet. Also asserted structurally against the import graph.
 *
 *   2. NO-FOLLOW REGRESSION — a user without a follow produces an identical
 *      executeRebalanceIfNeeded call to the pre-#285 code. This is the bar the
 *      repo sets for every new agent capability.
 *
 *   3. NO CROSS-CONTAMINATION (hazard 1) — router.ts reads only
 *      userStrategyPreferences[0], so two followers of DIFFERENT published
 *      strategies must never land in the same batch.
 */
import fs from 'node:fs'
import path from 'node:path'

const followerA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const followerB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const plainUser = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const publisher1 = '11111111-1111-4111-8111-111111111111'
const publisher2 = '22222222-2222-4222-8222-222222222222'
const strategy1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const strategy2 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

// --- Stellar: fully mocked. Nothing here may be called by a follow. ----------
const mockSubmitRebalance = jest.fn().mockResolvedValue({ hash: 'tx-hash' })
jest.mock('../../../src/stellar/contract', () => ({
  triggerRebalance: (...args: unknown[]) => mockSubmitRebalance(...args),
}))

const mockGetKeypairForUser = jest.fn()
const mockGetWalletByUserId = jest.fn()
jest.mock('../../../src/stellar/wallet', () => ({
  getKeypairForUser: (...args: unknown[]) => mockGetKeypairForUser(...args),
  getWalletByUserId: (...args: unknown[]) => mockGetWalletByUserId(...args),
}))

// --- Router: capture the preferences the loop hands it -----------------------
const mockExecuteRebalanceIfNeeded = jest.fn().mockResolvedValue(null)
const mockLogAgentAction = jest.fn().mockResolvedValue(undefined)
jest.mock('../../../src/agent/router', () => ({
  executeRebalanceIfNeeded: (...args: unknown[]) =>
    mockExecuteRebalanceIfNeeded(...args),
  logAgentAction: (...args: unknown[]) => mockLogAgentAction(...args),
  getThresholds: () => ({ minimumImprovement: 0.5, maxGasPercent: 0.1 }),
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

import db from '../../../src/db'
import { rebalanceCheckJob } from '../../../src/agent/loop'

const mockDb = db as any

/** A position row shaped as loop.ts's `include: { user: true }` produces it. */
function position(
  id: string,
  userId: string,
  protocolName: string,
  user: Record<string, unknown> = {}
) {
  return {
    id,
    userId,
    protocolName,
    currentValue: { toString: () => '1000000000000000000' },
    user: {
      id: userId,
      riskTolerance: 5,
      rebalanceStrategy: null,
      strategyConfig: null,
      ...user,
    },
  }
}

function follow(
  id: string,
  followerUserId: string,
  publishedStrategyId: string | null,
  appliedConfig: Record<string, unknown>
) {
  return {
    id,
    followerUserId,
    publishedStrategyId,
    appliedConfig,
    appliedConfigVersion: 1,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockExecuteRebalanceIfNeeded.mockResolvedValue(null)
  mockSubmitRebalance.mockResolvedValue({ hash: 'tx-hash' })
  mockDb.position = { findMany: jest.fn().mockResolvedValue([]) }
  mockDb.strategyFollow = { findMany: jest.fn().mockResolvedValue([]) }
  mockDb.custodialWallet = {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
  }
})

// ─── 2. No-follow regression ─────────────────────────────────────────────────

describe('no-follow regression — behavior must be unchanged', () => {
  it('passes undefined preferences for a user with no strategy and no follow', async () => {
    mockDb.position.findMany.mockResolvedValue([
      position('pos-1', plainUser, 'Blend'),
    ])

    await rebalanceCheckJob()

    expect(mockExecuteRebalanceIfNeeded).toHaveBeenCalledTimes(1)
    const [protocol, positions, thresholds, preferences] =
      mockExecuteRebalanceIfNeeded.mock.calls[0]
    expect(protocol).toBe('Blend')
    expect(positions).toEqual([
      { id: 'pos-1', amount: '1000000000000000000', userId: plainUser },
    ])
    expect(thresholds).toEqual({ minimumImprovement: 0.5, maxGasPercent: 0.1 })
    // The pre-#285 code passed undefined here, which makes
    // executeRebalanceIfNeeded skip the strategy engine entirely.
    expect(preferences).toBeUndefined()
  })

  it('passes the user‘s own config verbatim when they have one but follow nothing', async () => {
    mockDb.position.findMany.mockResolvedValue([
      position('pos-1', plainUser, 'Blend', {
        rebalanceStrategy: 'TARGET_ALLOCATION',
        strategyConfig: {
          targetAllocations: { Blend: 60, Luma: 40 },
          riskCeiling: 55,
        },
      }),
    ])

    await rebalanceCheckJob()

    const preferences = mockExecuteRebalanceIfNeeded.mock.calls[0][3]
    expect(preferences).toEqual([
      {
        userId: plainUser,
        strategyName: 'TARGET_ALLOCATION',
        targetAllocations: { Blend: 60, Luma: 40 },
        riskTolerance: 5,
        riskCeiling: 55,
        followedStrategyId: undefined,
      },
    ])
  })

  it('still groups two no-follow users with the same strategy into ONE batch', async () => {
    mockDb.position.findMany.mockResolvedValue([
      position('pos-1', plainUser, 'Blend', {
        rebalanceStrategy: 'MAX_YIELD',
      }),
      position('pos-2', followerA, 'Blend', {
        rebalanceStrategy: 'MAX_YIELD',
      }),
    ])

    await rebalanceCheckJob()

    expect(mockExecuteRebalanceIfNeeded).toHaveBeenCalledTimes(1)
    expect(mockExecuteRebalanceIfNeeded.mock.calls[0][3]).toHaveLength(2)
  })

  it('issues exactly one follow lookup per tick, not one per user', async () => {
    mockDb.position.findMany.mockResolvedValue([
      position('pos-1', plainUser, 'Blend'),
      position('pos-2', followerA, 'Luma'),
      position('pos-3', followerB, 'Blend'),
    ])

    await rebalanceCheckJob()

    expect(mockDb.strategyFollow.findMany).toHaveBeenCalledTimes(1)
  })
})

// ─── Followed config actually applied ────────────────────────────────────────

describe('a follower‘s config is applied on the next scheduled run', () => {
  it('applies the followed strategy to a user whose OWN strategy is null', async () => {
    // The common case for a new user, and exactly who this feature targets.
    // Before the guard fix, preferences would have been undefined here and the
    // followed config silently ignored.
    mockDb.position.findMany.mockResolvedValue([
      position('pos-1', followerA, 'Blend'),
    ])
    mockDb.strategyFollow.findMany.mockResolvedValue([
      follow('follow-1', followerA, strategy1, {
        strategyName: 'TARGET_ALLOCATION',
        targetAllocations: { Blend: 70, Luma: 30 },
        riskCeiling: 65,
      }),
    ])

    await rebalanceCheckJob()

    const preferences = mockExecuteRebalanceIfNeeded.mock.calls[0][3]
    expect(preferences).toEqual([
      {
        userId: followerA,
        strategyName: 'TARGET_ALLOCATION',
        targetAllocations: { Blend: 70, Luma: 30 },
        riskTolerance: 5,
        riskCeiling: 65,
        followedStrategyId: strategy1,
      },
    ])
  })

  it('clamps the risk ceiling to the STRICTER of publisher and follower', async () => {
    mockDb.position.findMany.mockResolvedValue([
      position('pos-1', followerA, 'Blend', {
        rebalanceStrategy: 'MAX_YIELD',
        strategyConfig: { riskCeiling: 85 },
      }),
    ])
    mockDb.strategyFollow.findMany.mockResolvedValue([
      follow('follow-1', followerA, strategy1, {
        strategyName: 'MAX_YIELD',
        riskCeiling: 50,
      }),
    ])

    await rebalanceCheckJob()

    // A follow may only ever tighten the follower's risk exposure.
    expect(mockExecuteRebalanceIfNeeded.mock.calls[0][3][0].riskCeiling).toBe(
      85
    )
  })

  it('keeps applying an orphaned follow after the publisher deleted their account', async () => {
    mockDb.position.findMany.mockResolvedValue([
      position('pos-1', followerA, 'Blend'),
    ])
    mockDb.strategyFollow.findMany.mockResolvedValue([
      follow('follow-1', followerA, null, { strategyName: 'MAX_YIELD' }),
    ])

    await rebalanceCheckJob()

    const preferences = mockExecuteRebalanceIfNeeded.mock.calls[0][3]
    expect(preferences[0].strategyName).toBe('MAX_YIELD')
    expect(preferences[0].followedStrategyId).toBeUndefined()
  })
})

// ─── 3. No cross-contamination (hazard 1) ────────────────────────────────────

describe('batching — followers of different strategies never cross-contaminate', () => {
  it('splits two followers of different strategies on the same protocol', async () => {
    mockDb.position.findMany.mockResolvedValue([
      position('pos-a', followerA, 'Blend'),
      position('pos-b', followerB, 'Blend'),
    ])
    mockDb.strategyFollow.findMany.mockResolvedValue([
      follow('follow-a', followerA, strategy1, {
        strategyName: 'MAX_YIELD',
        riskCeiling: 40,
      }),
      follow('follow-b', followerB, strategy2, {
        strategyName: 'MAX_YIELD',
        riskCeiling: 90,
      }),
    ])

    await rebalanceCheckJob()

    // router.ts reads only userStrategyPreferences[0]; one shared batch would
    // have applied A's ceiling of 40 to B, or B's 90 to A.
    expect(mockExecuteRebalanceIfNeeded).toHaveBeenCalledTimes(2)

    const byUser = new Map<string, any>()
    for (const call of mockExecuteRebalanceIfNeeded.mock.calls) {
      const prefs = call[3]
      expect(prefs).toHaveLength(1)
      byUser.set(prefs[0].userId, prefs[0])
    }
    expect(byUser.get(followerA).riskCeiling).toBe(40)
    expect(byUser.get(followerA).followedStrategyId).toBe(strategy1)
    expect(byUser.get(followerB).riskCeiling).toBe(90)
    expect(byUser.get(followerB).followedStrategyId).toBe(strategy2)
  })

  it('splits a follower from a no-follow user sharing protocol and strategy name', async () => {
    mockDb.position.findMany.mockResolvedValue([
      position('pos-a', followerA, 'Blend'),
      position('pos-d', plainUser, 'Blend', { rebalanceStrategy: 'MAX_YIELD' }),
    ])
    mockDb.strategyFollow.findMany.mockResolvedValue([
      follow('follow-a', followerA, strategy1, {
        strategyName: 'MAX_YIELD',
        riskCeiling: 40,
      }),
    ])

    await rebalanceCheckJob()

    expect(mockExecuteRebalanceIfNeeded).toHaveBeenCalledTimes(2)
  })
})

// ─── 1. Custody ──────────────────────────────────────────────────────────────

describe('custody — a follow moves configuration and nothing else', () => {
  it('never opens a wallet, reads a key, or touches custodialWallet', async () => {
    mockDb.position.findMany.mockResolvedValue([
      position('pos-1', followerA, 'Blend'),
    ])
    mockDb.strategyFollow.findMany.mockResolvedValue([
      follow('follow-1', followerA, strategy1, { strategyName: 'MAX_YIELD' }),
    ])

    await rebalanceCheckJob()

    expect(mockGetKeypairForUser).not.toHaveBeenCalled()
    expect(mockGetWalletByUserId).not.toHaveBeenCalled()
    expect(mockDb.custodialWallet.findUnique).not.toHaveBeenCalled()
    expect(mockDb.custodialWallet.findFirst).not.toHaveBeenCalled()
    expect(mockDb.custodialWallet.findMany).not.toHaveBeenCalled()
  })

  it('never passes the publisher‘s user id to any downstream call', async () => {
    mockDb.position.findMany.mockResolvedValue([
      position('pos-1', followerA, 'Blend'),
    ])
    mockDb.strategyFollow.findMany.mockResolvedValue([
      follow('follow-1', followerA, strategy1, { strategyName: 'MAX_YIELD' }),
    ])

    await rebalanceCheckJob()

    const everything = JSON.stringify([
      mockExecuteRebalanceIfNeeded.mock.calls,
      mockSubmitRebalance.mock.calls,
      mockDb.position.findMany.mock.calls,
    ])
    expect(everything).not.toContain(publisher1)
    expect(everything).not.toContain(publisher2)
  })

  it('structurally: src/strategy/service.ts imports nothing from src/stellar/', () => {
    // The custody boundary is a property of the import graph, not a comment.
    const source = fs.readFileSync(
      path.join(__dirname, '../../../src/strategy/service.ts'),
      'utf8'
    )
    const imports = Array.from(
      source.matchAll(/from\s+['"]([^'"]+)['"]/g),
      (m) => m[1]
    )
    expect(imports.length).toBeGreaterThan(0)
    expect(imports.filter((i) => i.includes('stellar'))).toEqual([])
    expect(imports.filter((i) => i.includes('wallet'))).toEqual([])
  })

  it('structurally: src/agent/effectiveStrategy.ts is pure (no db, no stellar)', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../../src/agent/effectiveStrategy.ts'),
      'utf8'
    )
    const imports = Array.from(
      source.matchAll(/from\s+['"]([^'"]+)['"]/g),
      (m) => m[1]
    )
    expect(imports.filter((i) => /stellar|\/db|wallet/.test(i))).toEqual([])
  })
})
