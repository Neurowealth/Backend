/**
 * Tests for #765 and #763: amount validation and rebalance safety gates.
 *
 * #765 â€” Assistant money tools must reject amounts outside onChainAmountSchema
 * limits (sub-stroop, more than 7 decimal places, above max, non-finite) and
 * must enforce the same per-user sensitive-op velocity budget as the REST path.
 *
 * #763 â€” The rebalance tool must check the volatility gate and circuit-breaker
 * before moving funds, pass blockedProtocols to executeRebalanceIfNeeded, and
 * produce a dry-run preview that uses the user's actual strategy path instead
 * of always running MAX_YIELD comparison.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { getTool } from '../../../src/agent/tools/registry'
import {
  checkAndRecordSensitiveOp,
  __resetSensitiveOpsVelocityForTests,
} from '../../../src/agent/tools/actionTools'

// ---------------------------------------------------------------------------
// Shared mock setup
// ---------------------------------------------------------------------------

vi.mock('../../../src/db', () => ({
  default: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    position: { findMany: vi.fn() },
    recurringDepositPlan: { create: vi.fn() },
    alertRule: { create: vi.fn() },
    publishedStrategy: { findFirst: vi.fn() },
  },
}))

vi.mock('../../../src/controllers/transaction-controller', () => ({
  executeDeposit: vi.fn(),
  executeWithdraw: vi.fn(),
}))

vi.mock('../../../src/agent/router', () => ({
  executeRebalanceIfNeeded: vi.fn(),
  getThresholds: vi.fn(() => ({ minimumImprovement: 0.5, maxGasPercent: 0.1 })),
  compareProtocols: vi.fn(),
  logAgentAction: vi.fn(),
}))

vi.mock('../../../src/agent/breakerService', () => ({
  getBreakerStatusForUser: vi.fn(),
}))

vi.mock('../../../src/agent/volatilityCircuitBreaker', () => ({
  isPortfolioRebalanceAllowed: vi.fn(),
}))

vi.mock('../../../src/strategy/service', () => ({
  loadActiveFollowsForUsers: vi.fn(() => new Map()),
  followStrategy: vi.fn(),
  unfollowStrategy: vi.fn(),
}))

vi.mock('../../../src/agent/effectiveStrategy', () => ({
  resolveEffectiveConfig: vi.fn((own) => own),
  isKnownStrategyName: vi.fn(() => true),
}))

vi.mock('../../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import db from '../../../src/db'
import {
  executeDeposit,
  executeWithdraw,
} from '../../../src/controllers/transaction-controller'
import {
  executeRebalanceIfNeeded,
  compareProtocols,
} from '../../../src/agent/router'
import { getBreakerStatusForUser } from '../../../src/agent/breakerService'
import { isPortfolioRebalanceAllowed } from '../../../src/agent/volatilityCircuitBreaker'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockCtx = (overrides = {}) => ({
  userId: 'user-abc',
  actingAsUserId: null,
  dryRun: false,
  ...overrides,
})

function schemaFor(toolName: string) {
  const tool = getTool(toolName)
  if (!tool) throw new Error(`Unknown tool: ${toolName}`)
  return tool.argsSchema
}

function executeFor(toolName: string) {
  const tool = getTool(toolName)
  if (!tool) throw new Error(`Unknown tool: ${toolName}`)
  return tool.execute.bind(tool)
}

// ---------------------------------------------------------------------------
// #765 â€” Amount validation
// ---------------------------------------------------------------------------

describe('#765 â€” onChainAmountSchema applied to money tool arg schemas', () => {
  describe('deposit argsSchema', () => {
    const schema = schemaFor('deposit')

    it('accepts a valid amount', () => {
      expect(schema.safeParse({ amount: 10, assetSymbol: 'USDC' }).success).toBe(true)
    })

    it('rejects sub-stroop amount (0.00000001 â€” 8 decimals)', () => {
      expect(schema.safeParse({ amount: 0.00000001, assetSymbol: 'USDC' }).success).toBe(false)
    })

    it('rejects amount with more than 7 decimal places', () => {
      expect(schema.safeParse({ amount: 1.12345678, assetSymbol: 'USDC' }).success).toBe(false)
    })

    it('rejects Infinity', () => {
      expect(schema.safeParse({ amount: Infinity, assetSymbol: 'USDC' }).success).toBe(false)
    })

    it('rejects 1e20 (above MAX_CONTRACT_AMOUNT)', () => {
      expect(schema.safeParse({ amount: 1e20, assetSymbol: 'USDC' }).success).toBe(false)
    })

    it('accepts exactly 7 decimal places', () => {
      expect(schema.safeParse({ amount: 0.1234567, assetSymbol: 'USDC' }).success).toBe(true)
    })
  })

  describe('withdraw argsSchema', () => {
    const schema = schemaFor('withdraw')

    it('rejects sub-stroop amount', () => {
      expect(schema.safeParse({ amount: 0.000000001 }).success).toBe(false)
    })

    it('rejects more than 7 decimal places', () => {
      expect(schema.safeParse({ amount: 5.12345678 }).success).toBe(false)
    })

    it('rejects NaN', () => {
      expect(schema.safeParse({ amount: NaN }).success).toBe(false)
    })

    it('accepts a valid amount', () => {
      expect(schema.safeParse({ amount: 50 }).success).toBe(true)
    })
  })

  describe('create_recurring_deposit argsSchema', () => {
    const schema = schemaFor('create_recurring_deposit')

    it('rejects sub-stroop amount', () => {
      expect(
        schema.safeParse({ amount: 0.00000001, cadence: 'WEEKLY', assetSymbol: 'USDC' }).success
      ).toBe(false)
    })

    it('rejects more than 7 decimal places', () => {
      expect(
        schema.safeParse({ amount: 1.12345678, cadence: 'MONTHLY', assetSymbol: 'USDC' }).success
      ).toBe(false)
    })

    it('accepts a valid amount', () => {
      expect(
        schema.safeParse({ amount: 100, cadence: 'MONTHLY', assetSymbol: 'USDC' }).success
      ).toBe(true)
    })
  })
})

// ---------------------------------------------------------------------------
// #765 â€” Per-user velocity budget
// ---------------------------------------------------------------------------

describe('#765 â€” sensitive-op velocity counter', () => {
  beforeEach(() => {
    __resetSensitiveOpsVelocityForTests()
  })

  it('allows up to SENSITIVE_ASSISTANT_MAX calls within the window', () => {
    const max = Number(process.env.SENSITIVE_RATE_LIMIT_MAX) || 10
    const now = Date.now()
    for (let i = 0; i < max; i++) {
      expect(checkAndRecordSensitiveOp('user-1', now + i)).toBe(true)
    }
  })

  it('rejects the (MAX+1)th call within the window', () => {
    const max = Number(process.env.SENSITIVE_RATE_LIMIT_MAX) || 10
    const now = Date.now()
    for (let i = 0; i < max; i++) checkAndRecordSensitiveOp('user-1', now + i)
    expect(checkAndRecordSensitiveOp('user-1', now + max)).toBe(false)
  })

  it('allows a new call after the window expires', () => {
    const max = Number(process.env.SENSITIVE_RATE_LIMIT_MAX) || 10
    const windowMs = Number(process.env.SENSITIVE_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000
    const now = Date.now()
    for (let i = 0; i < max; i++) checkAndRecordSensitiveOp('user-1', now)
    // past the window
    expect(checkAndRecordSensitiveOp('user-1', now + windowMs + 1)).toBe(true)
  })

  it('is scoped per user â€” user-2 is unaffected by user-1 exhausting their budget', () => {
    const max = Number(process.env.SENSITIVE_RATE_LIMIT_MAX) || 10
    const now = Date.now()
    for (let i = 0; i < max + 1; i++) checkAndRecordSensitiveOp('user-1', now)
    expect(checkAndRecordSensitiveOp('user-2', now)).toBe(true)
  })

  it('deposit execute returns error when velocity budget is exhausted', async () => {
    __resetSensitiveOpsVelocityForTests()
    const max = Number(process.env.SENSITIVE_RATE_LIMIT_MAX) || 10
    const now = Date.now()
    for (let i = 0; i < max; i++) checkAndRecordSensitiveOp('user-budget', now + i)

    vi.mocked(db.user.findUnique).mockResolvedValue({
      walletAddress: 'GFAKE12345',
    } as any)

    const execute = executeFor('deposit')
    const result = await execute({ amount: 10, assetSymbol: 'USDC' }, mockCtx({ userId: 'user-budget' }))
    expect(result.ok).toBe(false)
    expect((result as any).error).toMatch(/Too many money-movement/i)
    expect(executeDeposit).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// #763 â€” Rebalance tool circuit-breaker and volatility gates
// ---------------------------------------------------------------------------

describe('#763 â€” rebalance tool safety gates', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    __resetSensitiveOpsVelocityForTests()

    vi.mocked(db.user.findUnique).mockResolvedValue({
      rebalanceStrategy: 'MAX_YIELD',
      strategyConfig: {},
      riskTolerance: 'MODERATE',
      liquidityFloor: null,
    } as any)

    vi.mocked(db.position.findMany).mockResolvedValue([
      { id: 'pos-1', protocolName: 'ProtocolA', currentValue: '1000', userId: 'user-abc' },
    ] as any)

    vi.mocked(isPortfolioRebalanceAllowed).mockResolvedValue(true)
    vi.mocked(getBreakerStatusForUser).mockResolvedValue({
      global: null,
      affectingYou: [],
    } as any)

    vi.mocked(executeRebalanceIfNeeded).mockResolvedValue(null)
  })

  it('blocks execution when volatility gate is CLOSED', async () => {
    vi.mocked(isPortfolioRebalanceAllowed).mockResolvedValue(false)
    const execute = executeFor('rebalance')
    const result = await execute({}, mockCtx())
    expect(result.ok).toBe(false)
    expect((result as any).error).toMatch(/volatility/i)
    expect(executeRebalanceIfNeeded).not.toHaveBeenCalled()
  })

  it('blocks execution when GLOBAL circuit breaker is OPEN', async () => {
    vi.mocked(getBreakerStatusForUser).mockResolvedValue({
      global: 'DRAWDOWN_EXCEEDED',
      affectingYou: [],
    } as any)
    const execute = executeFor('rebalance')
    const result = await execute({}, mockCtx())
    expect(result.ok).toBe(false)
    expect((result as any).error).toMatch(/global circuit breaker/i)
    expect(executeRebalanceIfNeeded).not.toHaveBeenCalled()
  })

  it('blocks execution and fails closed when breaker check throws', async () => {
    vi.mocked(getBreakerStatusForUser).mockRejectedValue(new Error('DB timeout'))
    const execute = executeFor('rebalance')
    const result = await execute({}, mockCtx())
    expect(result.ok).toBe(false)
    expect((result as any).error).toMatch(/safety gates/i)
    expect(executeRebalanceIfNeeded).not.toHaveBeenCalled()
  })

  it('blocks execution when USER circuit breaker is OPEN (affectingYou)', async () => {
    vi.mocked(getBreakerStatusForUser).mockResolvedValue({
      global: null,
      affectingYou: ['rebalancing paused for your account: manual'],
    } as any)
    const execute = executeFor('rebalance')
    const result = await execute({}, mockCtx())
    expect(result.ok).toBe(false)
    expect((result as any).error).toMatch(/paused for your account/i)
    expect(executeRebalanceIfNeeded).not.toHaveBeenCalled()
  })

  it('succeeds and returns rebalance results when all gates pass', async () => {
    vi.mocked(executeRebalanceIfNeeded).mockResolvedValue({
      fromProtocol: 'ProtocolA',
      toProtocol: 'ProtocolB',
      amount: '1000',
      improvedBy: 1.2,
      txHash: 'abc123',
      timestamp: new Date().toISOString(),
    } as any)

    const execute = executeFor('rebalance')
    const result = await execute({}, mockCtx())

    expect(result.ok).toBe(true)
    expect((result as any).data.rebalanced).toBe(true)
    expect(isPortfolioRebalanceAllowed).toHaveBeenCalledWith('user-abc')
    expect(getBreakerStatusForUser).toHaveBeenCalledWith('user-abc')
  })

  it('dry-run uses compareProtocols for MAX_YIELD users (no strategy context)', async () => {
    vi.mocked(db.user.findUnique).mockResolvedValue({
      rebalanceStrategy: null,
      strategyConfig: {},
      riskTolerance: null,
      liquidityFloor: null,
    } as any)

    vi.mocked(compareProtocols).mockResolvedValue({
      shouldRebalance: true,
      improvement: 1.5,
      best: { name: 'ProtocolB' },
    } as any)

    const execute = executeFor('rebalance')
    const result = await execute({}, mockCtx({ dryRun: true }))

    expect(result.ok).toBe(true)
    expect((result as any).data.preview).toBe(true)
    expect(compareProtocols).toHaveBeenCalled()
    // executeRebalanceIfNeeded should NOT be called for no-strategy-context dry-run
    expect(executeRebalanceIfNeeded).not.toHaveBeenCalled()
  })

  it('dry-run uses executeRebalanceIfNeeded for TARGET_ALLOCATION users', async () => {
    vi.mocked(db.user.findUnique).mockResolvedValue({
      rebalanceStrategy: 'TARGET_ALLOCATION',
      strategyConfig: { targetAllocations: { ProtocolA: 100 } },
      riskTolerance: 'MODERATE',
      liquidityFloor: null,
    } as any)

    vi.mocked(executeRebalanceIfNeeded).mockResolvedValue({
      fromProtocol: 'ProtocolA',
      toProtocol: 'ProtocolB',
      amount: '500',
      improvedBy: 0.8,
      txHash: null,
      timestamp: new Date().toISOString(),
    } as any)

    const execute = executeFor('rebalance')
    const result = await execute({}, mockCtx({ dryRun: true }))

    expect(result.ok).toBe(true)
    expect((result as any).data.preview).toBe(true)
    // Should use executeRebalanceIfNeeded with dryRun flag for strategy-context users
    expect(executeRebalanceIfNeeded).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.any(Object),
      expect.any(Array),
      expect.objectContaining({ dryRun: true })
    )
    expect(compareProtocols).not.toHaveBeenCalled()
  })
})
