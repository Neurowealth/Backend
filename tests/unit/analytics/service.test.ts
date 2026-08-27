/**
 * Allocation-suggestion service unit tests (#322).
 *
 * Prisma is mocked wholesale (the repo's unit-test convention) so the precedence
 * rules — which decide what advice someone gets about their money — are tested
 * in isolation from the database.
 *
 * The rules under test are deliberately NOT unified in the implementation: a
 * follow may only TIGHTEN a risk ceiling (Math.max), while an active goal
 * OVERRIDES it outright (??). Both mirror the agent exactly; a suggestion
 * computed under a third rule would be advice about a portfolio the agent will
 * never build.
 */

jest.mock('../../../src/db', () => ({ __esModule: true, default: {} }))
jest.mock('../../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  logBackgroundJob: jest.fn(),
}))

import db from '../../../src/db'
import {
  ADVISORY_DISCLAIMER,
  BACKTEST_CAVEAT,
  SuggestionUserNotFoundError,
  computeInputHash,
  resolveEffectiveInputs,
  suggestAllocation,
} from '../../../src/analytics/service'

const mockDb = db as any

const DAY = 24 * 60 * 60 * 1000
const NOW = new Date('2026-08-17T00:00:00Z')
const USER_ID = '11111111-1111-4111-8111-111111111111'

function rateRows(spec: Record<string, number>, days = 90) {
  const rows: any[] = []
  for (let d = 0; d < days; d++) {
    const fetchedAt = new Date(NOW.getTime() - (days - 1 - d) * DAY)
    for (const [protocolName, base] of Object.entries(spec)) {
      rows.push({
        protocolName,
        assetSymbol: 'USDC',
        // Deterministic oscillation so Sigma is non-degenerate and each
        // protocol has a distinct phase.
        supplyApy: base + Math.sin((d + protocolName.length) / 6),
        fetchedAt,
      })
    }
  }
  return rows
}

function setupDb(
  overrides: {
    user?: any
    follow?: any
    goal?: any
    rates?: any[]
    scores?: any[]
    positions?: any[]
  } = {}
) {
  mockDb.user = {
    findUnique: jest.fn().mockResolvedValue(
      overrides.user === null
        ? null
        : (overrides.user ?? {
            id: USER_ID,
            riskTolerance: 5,
            strategyConfig: null,
          })
    ),
  }
  mockDb.strategyFollow = {
    findFirst: jest.fn().mockResolvedValue(overrides.follow ?? null),
  }
  mockDb.savingsGoal = {
    findFirst: jest.fn().mockResolvedValue(overrides.goal ?? null),
  }
  mockDb.protocolRate = {
    findMany: jest
      .fn()
      .mockResolvedValue(
        overrides.rates ?? rateRows({ Blend: 11, Luma: 8, Nova: 6 })
      ),
  }
  mockDb.protocolRiskScore = {
    findMany: jest.fn().mockResolvedValue(
      overrides.scores ?? [
        { protocolName: 'Blend', score: 72, insufficientHistory: false },
        { protocolName: 'Luma', score: 61, insufficientHistory: false },
        { protocolName: 'Nova', score: 88, insufficientHistory: false },
      ]
    ),
  }
  mockDb.position = {
    findMany: jest.fn().mockResolvedValue(overrides.positions ?? []),
  }
  mockDb.allocationSuggestion = {
    create: jest.fn().mockResolvedValue({ id: 'suggestion-1' }),
  }
}

describe('resolveEffectiveInputs — risk ceiling precedence', () => {
  it('with no follow and no goal, uses the user own ceiling', () => {
    const r = resolveEffectiveInputs(5, { riskCeiling: 60 }, null, null)
    expect(r.effectiveRiskCeiling).toBe(60)
    expect(r.ceilingSource).toBe('own')
  })

  it('a follow may only TIGHTEN — stricter (higher) ceiling wins', () => {
    const r = resolveEffectiveInputs(
      5,
      { riskCeiling: 50 },
      { riskCeiling: 80 },
      null
    )
    expect(r.effectiveRiskCeiling).toBe(80)
    expect(r.ceilingSource).toBe('follow')
  })

  it('a follow can never LOOSEN a tighter own ceiling', () => {
    // The whole point: clicking "follow" must not widen risk exposure.
    const r = resolveEffectiveInputs(
      5,
      { riskCeiling: 90 },
      { riskCeiling: 30 },
      null
    )
    expect(r.effectiveRiskCeiling).toBe(90)
  })

  it('an active goal OVERRIDES outright, even to loosen', () => {
    const r = resolveEffectiveInputs(
      5,
      { riskCeiling: 90 },
      { riskCeiling: 80 },
      40
    )
    expect(r.effectiveRiskCeiling).toBe(40)
    expect(r.ceilingSource).toBe('goal')
  })

  it('is undefined when nothing sets a ceiling', () => {
    const r = resolveEffectiveInputs(5, null, null, null)
    expect(r.effectiveRiskCeiling).toBeUndefined()
    expect(r.ceilingSource).toBe('none')
  })

  it('a followed strategy replaces allocations wholesale, not key-by-key', () => {
    const r = resolveEffectiveInputs(
      5,
      { targetAllocations: { Own: 100 } },
      { strategyName: 'TARGET_ALLOCATION', targetAllocations: { Copied: 100 } },
      null
    )
    expect(r.currentAllocations).toEqual({ Copied: 100 })
  })

  it('tolerates a malformed strategyConfig Json column', () => {
    // The column has no DB-level shape guarantee.
    const r = resolveEffectiveInputs(5, 'not-an-object', null, null)
    expect(r.currentAllocations).toBeUndefined()
    expect(r.effectiveRiskCeiling).toBeUndefined()
  })
})

describe('computeInputHash', () => {
  const base = {
    protocols: ['A', 'B'],
    expectedReturns: [0.08, 0.05],
    covariance: [
      [0.0004, 0.0001],
      [0.0001, 0.0002],
    ],
    riskTolerance: 5,
    effectiveRiskCeiling: 60,
    lookbackDays: 90,
  }

  it('is stable for identical inputs', () => {
    expect(computeInputHash(base)).toBe(computeInputHash(base))
  })

  it('carries the sha256: prefix convention', () => {
    expect(computeInputHash(base)).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('changes when riskTolerance changes', () => {
    expect(computeInputHash({ ...base, riskTolerance: 6 })).not.toBe(
      computeInputHash(base)
    )
  })

  it('changes when the effective ceiling changes', () => {
    expect(computeInputHash({ ...base, effectiveRiskCeiling: 70 })).not.toBe(
      computeInputHash(base)
    )
  })

  it('changes when the universe changes', () => {
    expect(
      computeInputHash({
        ...base,
        protocols: ['A', 'C'],
      })
    ).not.toBe(computeInputHash(base))
  })

  it('is insensitive to float noise far below what moves a weight', () => {
    // 1e-15 on an expected return cannot change a 2dp weight, and a hash that
    // flipped on it would make "did my recommendation change?" unanswerable.
    expect(
      computeInputHash({
        ...base,
        expectedReturns: [0.08 + 1e-15, 0.05],
      })
    ).toBe(computeInputHash(base))
  })

  it('distinguishes a no-ceiling input from a ceiling of 0', () => {
    expect(
      computeInputHash({ ...base, effectiveRiskCeiling: undefined })
    ).not.toBe(computeInputHash({ ...base, effectiveRiskCeiling: 0 }))
  })
})

describe('suggestAllocation', () => {
  beforeEach(() => setupDb())

  it('throws SuggestionUserNotFoundError for an unknown user', async () => {
    setupDb({ user: null })
    await expect(suggestAllocation(USER_ID, { now: NOW })).rejects.toThrow(
      SuggestionUserNotFoundError
    )
  })

  it('returns an advisory result with weights summing to 100', async () => {
    const r = await suggestAllocation(USER_ID, { now: NOW })

    expect(r.status).toBe('ok')
    expect(r.isSuggestion).toBe(true)
    expect(r.disclaimer).toBe(ADVISORY_DISCLAIMER)

    const sum = Object.values(r.weights).reduce((s, v) => s + v, 0)
    expect(Math.abs(sum - 100)).toBeLessThanOrEqual(0.01)
  })

  it('NEVER writes to the user record', async () => {
    await suggestAllocation(USER_ID, { now: NOW })
    // The mock has no update method at all; assert nothing tried to add one.
    expect((mockDb.user as any).update).toBeUndefined()
    expect((mockDb.user as any).upsert).toBeUndefined()
  })

  it('persists exactly one AllocationSuggestion row', async () => {
    const r = await suggestAllocation(USER_ID, { now: NOW })
    expect(mockDb.allocationSuggestion.create).toHaveBeenCalledTimes(1)

    const arg = mockDb.allocationSuggestion.create.mock.calls[0][0]
    expect(arg.data.userId).toBe(USER_ID)
    expect(arg.data.inputHash).toBe(r.inputHash)
    expect(arg.data.status).toBe('ok')
    expect(r.id).toBe('suggestion-1')
  })

  it('skips persistence when asked to', async () => {
    const r = await suggestAllocation(USER_ID, { now: NOW, persist: false })
    expect(mockDb.allocationSuggestion.create).not.toHaveBeenCalled()
    expect(r.id).toBeUndefined()
  })

  it('is deterministic — same inputs give the same hash and weights', async () => {
    const a = await suggestAllocation(USER_ID, { now: NOW, persist: false })
    const b = await suggestAllocation(USER_ID, { now: NOW, persist: false })
    expect(b.inputHash).toBe(a.inputHash)
    expect(b.weights).toEqual(a.weights)
  })

  it('applies a followed strategy tighter ceiling to the universe', async () => {
    setupDb({
      user: { id: USER_ID, riskTolerance: 5, strategyConfig: null },
      follow: { appliedConfig: { riskCeiling: 85 } },
    })

    const r = await suggestAllocation(USER_ID, { now: NOW, persist: false })

    expect(r.effectiveRiskCeiling).toBe(85)
    // Only Nova (88) clears an 85 ceiling, so the universe is too small.
    expect(r.status).toBe('insufficient_universe')
    expect(
      r.excluded
        .filter((e) => e.reason === 'risk_ceiling')
        .map((e) => e.protocol)
    ).toEqual(expect.arrayContaining(['Blend', 'Luma']))
  })

  it('an active goal ceiling overrides the followed one', async () => {
    setupDb({
      user: { id: USER_ID, riskTolerance: 5, strategyConfig: null },
      follow: { appliedConfig: { riskCeiling: 85 } },
      goal: { riskCeiling: 60 },
    })

    const r = await suggestAllocation(USER_ID, { now: NOW, persist: false })

    expect(r.effectiveRiskCeiling).toBe(60)
    expect(r.ceilingSource).toBe('goal')
    expect(r.status).toBe('ok')
  })

  it('reports a too-tight ceiling as insufficient_universe naming riskCeiling', async () => {
    setupDb({
      user: {
        id: USER_ID,
        riskTolerance: 5,
        strategyConfig: { riskCeiling: 99 },
      },
    })

    const r = await suggestAllocation(USER_ID, { now: NOW, persist: false })

    expect(r.status).toBe('insufficient_universe')
    if (r.outcome.status !== 'insufficient_universe') throw new Error('shape')
    expect(r.outcome.bindingConstraint).toBe('riskCeiling')
    expect(r.weights).toEqual({})
  })

  it('returns insufficient_universe when history is too short', async () => {
    setupDb({ rates: rateRows({ Blend: 11, Luma: 8 }, 5) })
    const r = await suggestAllocation(USER_ID, { now: NOW, persist: false })
    expect(r.status).toBe('insufficient_universe')
    expect(
      r.excluded.some((e) => e.reason === 'insufficient_aligned_history')
    ).toBe(true)
  })
})

describe('suggestAllocation — backtest comparison', () => {
  it('returns only the suggested leg when the user has no allocation', async () => {
    setupDb()
    const r = await suggestAllocation(USER_ID, { now: NOW, persist: false })

    expect(r.backtest).not.toBeNull()
    expect(r.backtest?.suggested).toBeDefined()
    expect(r.backtest?.current).toBeNull()
    expect(r.backtest?.caveat).toBe(BACKTEST_CAVEAT)
  })

  it('returns both legs when the user has a current allocation', async () => {
    setupDb({
      user: {
        id: USER_ID,
        riskTolerance: 5,
        strategyConfig: { targetAllocations: { Blend: 50, Luma: 50 } },
      },
    })

    const r = await suggestAllocation(USER_ID, { now: NOW, persist: false })

    expect(r.backtest?.suggested).toBeDefined()
    expect(r.backtest?.current).not.toBeNull()
    expect(r.currentAllocations).toEqual({ Blend: 50, Luma: 50 })
  })

  it('anchors the notional to the user active position value', async () => {
    setupDb({ positions: [{ currentValue: 2500 }, { currentValue: 1500 }] })
    const r = await suggestAllocation(USER_ID, { now: NOW, persist: false })
    expect(r.backtest?.startingAmount).toBe(4000)
  })

  it('is skipped entirely when runBacktest is false', async () => {
    setupDb()
    const r = await suggestAllocation(USER_ID, {
      now: NOW,
      persist: false,
      runBacktest: false,
    })
    expect(r.backtest).toBeNull()
    // The job path must not pay for two historical replays per user.
    expect(mockDb.position.findMany).not.toHaveBeenCalled()
  })
})
