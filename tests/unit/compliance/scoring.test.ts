/**
 * Transaction risk-scoring engine unit tests (#321).
 *
 * scoring.ts is pure (no DB, no clock reads), so every test builds its own
 * context and asserts directly on the result — same style as
 * tests/unit/services/alertEvaluator.test.ts. The one non-negotiable
 * property from the issue: the agent's own rebalances must never
 * false-positive on velocity/structuring, however suspicious the raw pattern
 * looks — that gets its own dedicated describe block at the bottom.
 */

import {
  scoreTransaction,
  computeAmountAnomalyFeature,
  computeVelocityFeature,
  computeStructuringFeature,
  computeNewDestinationFeature,
  computeAccountAgeFeature,
  computeSubAccountFanOutFeature,
  computeReferralGraphFeature,
  median,
  modifiedZScore,
  linearRamp,
  clamp,
  isWithinTolerance,
  DEFAULT_SCORING_CONFIG,
  MODEL_VERSION,
  type ScoredTransaction,
  type HistoricalTransaction,
  type AccountContext,
  type TransactionContext,
  type FeatureCode,
  type ScoringResult,
} from '../../../src/compliance/scoring'

const NOW = new Date('2026-01-15T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000

function tx(overrides: Partial<ScoredTransaction> = {}): ScoredTransaction {
  return {
    id: 'tx-1',
    userId: 'user-1',
    type: 'DEPOSIT',
    amount: 100,
    assetSymbol: 'USDC',
    createdAt: NOW,
    destinationAddress: null,
    isAgentDriven: false,
    ...overrides,
  }
}

function hist(
  overrides: Partial<HistoricalTransaction> = {}
): HistoricalTransaction {
  return {
    type: 'DEPOSIT',
    amount: 100,
    assetSymbol: 'USDC',
    createdAt: new Date(NOW.getTime() - 10 * DAY),
    destinationAddress: null,
    isAgentDriven: false,
    ...overrides,
  }
}

function account(overrides: Partial<AccountContext> = {}): AccountContext {
  return {
    userId: 'user-1',
    // 1 year old — well outside every "new account" window used below.
    accountCreatedAt: new Date(NOW.getTime() - 365 * DAY),
    transactionHistory: [],
    knownDestinationAddresses: [],
    destinationAccountAgeMs: null,
    subAccount: undefined,
    referral: undefined,
    ...overrides,
  }
}

function feature(result: ScoringResult, code: FeatureCode) {
  const found = result.features.find((f) => f.feature === code)
  if (!found) throw new Error(`Feature ${code} missing from result`)
  return found
}

// ── Math helpers ─────────────────────────────────────────────────────────

describe('median', () => {
  it('returns 0 for an empty array', () => {
    expect(median([])).toBe(0)
  })

  it('returns the middle value for an odd-length array', () => {
    expect(median([3, 1, 2])).toBe(2)
  })

  it('averages the two middle values for an even-length array', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5)
  })
})

describe('modifiedZScore', () => {
  it('returns 0 for an empty population', () => {
    expect(modifiedZScore(100, [])).toBe(0)
  })

  it('returns ~0 for a value at the population median', () => {
    expect(modifiedZScore(100, [80, 90, 100, 110, 120])).toBeCloseTo(0, 5)
  })

  it('returns a large positive z for a value far above a tight population', () => {
    const population = [98, 99, 100, 101, 102]
    expect(modifiedZScore(500, population)).toBeGreaterThan(5)
  })

  it('is robust to a single outlier (MAD, not stddev)', () => {
    // A mean/stddev z-score would be heavily dragged toward the 5000 outlier;
    // the median-based approach should still flag 100 vs. a population that's
    // otherwise tightly clustered around 10.
    const population = [10, 11, 9, 10, 5000]
    const z = modifiedZScore(100, population)
    expect(Math.abs(z)).toBeGreaterThan(5)
  })

  it('falls back to mean-absolute-deviation when MAD is 0 but the population has some spread', () => {
    // Median of |x - median| is 0 (more than half the population is 100), but
    // the population isn't fully identical (one 200). A naive implementation
    // would divide by zero or always return 0, making such an account immune
    // to ever triggering an amount anomaly.
    const population = [100, 100, 100, 100, 200]
    expect(modifiedZScore(100, population)).toBe(0)
    expect(modifiedZScore(10_000, population)).toBeGreaterThan(0)
    expect(Number.isFinite(modifiedZScore(10_000, population))).toBe(true)
  })

  it('returns Infinity when the population has zero spread and the value differs', () => {
    // Degenerate case: MAD and mean-AD are both 0 (identical population) and
    // the new value isn't equal to it — there's no scale to divide by at all.
    expect(modifiedZScore(200, [100, 100])).toBe(Infinity)
  })
})

describe('linearRamp', () => {
  it('is 0 at/below the low bound', () => {
    expect(linearRamp(1, 2, 10)).toBe(0)
    expect(linearRamp(2, 2, 10)).toBe(0)
  })

  it('is 100 at/above the high bound', () => {
    expect(linearRamp(10, 2, 10)).toBe(100)
    expect(linearRamp(50, 2, 10)).toBe(100)
  })

  it('ramps linearly in between', () => {
    expect(linearRamp(6, 2, 10)).toBe(50)
  })

  it('treats +Infinity as saturated and non-positive infinities as 0', () => {
    expect(linearRamp(Infinity, 2, 10)).toBe(100)
    expect(linearRamp(-Infinity, 2, 10)).toBe(0)
  })
})

describe('clamp', () => {
  it('bounds a value to [min, max]', () => {
    expect(clamp(-5, 0, 100)).toBe(0)
    expect(clamp(150, 0, 100)).toBe(100)
    expect(clamp(50, 0, 100)).toBe(50)
  })
})

describe('isWithinTolerance', () => {
  it('treats two zeros as within tolerance', () => {
    expect(isWithinTolerance(0, 0, 0.05)).toBe(true)
  })

  it('accepts a difference within the percentage band', () => {
    expect(isWithinTolerance(100, 104, 0.05)).toBe(true)
  })

  it('rejects a difference outside the percentage band', () => {
    expect(isWithinTolerance(100, 120, 0.05)).toBe(false)
  })
})

// ── AMOUNT_ANOMALY ───────────────────────────────────────────────────────

describe('computeAmountAnomalyFeature', () => {
  const cfg = DEFAULT_SCORING_CONFIG.amount

  it('is not triggered with fewer than minHistorySamples', () => {
    const history = [hist(), hist(), hist()] // 3 < default 5
    const result = computeAmountAnomalyFeature(
      tx({ amount: 100_000 }),
      history,
      cfg
    )
    expect(result.triggered).toBe(false)
    expect(result.score).toBe(0)
  })

  it('is not triggered for an amount consistent with history', () => {
    const history = [100, 95, 105, 98, 102, 101].map((amount) =>
      hist({ amount })
    )
    const result = computeAmountAnomalyFeature(
      tx({ amount: 100 }),
      history,
      cfg
    )
    expect(result.triggered).toBe(false)
  })

  it('is triggered for an amount far outside the historical norm', () => {
    const history = [100, 95, 105, 98, 102, 101].map((amount) =>
      hist({ amount })
    )
    const result = computeAmountAnomalyFeature(
      tx({ amount: 50_000 }),
      history,
      cfg
    )
    expect(result.triggered).toBe(true)
    expect(result.score).toBeGreaterThan(0)
    expect(result.reasonCodes).toContain('AMOUNT_ZSCORE_HIGH')
  })

  it('only compares against the same transaction type and asset', () => {
    const history = [
      hist({ type: 'WITHDRAWAL', amount: 50_000 }), // wrong type, would look normal-ish
      hist({ assetSymbol: 'XLM', amount: 50_000 }), // wrong asset
      hist({ amount: 100 }),
      hist({ amount: 105 }),
      hist({ amount: 98 }),
      hist({ amount: 102 }),
      hist({ amount: 101 }),
    ]
    const result = computeAmountAnomalyFeature(
      tx({ amount: 50_000 }),
      history,
      cfg
    )
    expect(result.triggered).toBe(true)
  })

  it('excludes agent-driven rows from the historical baseline', () => {
    const history = [
      hist({ amount: 50_000, isAgentDriven: true }),
      hist({ amount: 100 }),
      hist({ amount: 105 }),
      hist({ amount: 98 }),
      hist({ amount: 102 }),
      hist({ amount: 101 }),
    ]
    // If the agent row leaked into the baseline, 50_000 would look normal.
    const result = computeAmountAnomalyFeature(
      tx({ amount: 50_000 }),
      history,
      cfg
    )
    expect(result.triggered).toBe(true)
  })
})

// ── VELOCITY ─────────────────────────────────────────────────────────────

describe('computeVelocityFeature', () => {
  const cfg = DEFAULT_SCORING_CONFIG.velocity

  it('is not triggered for an isolated deposit with no recent history', () => {
    const result = computeVelocityFeature(tx(), [], cfg)
    expect(result.triggered).toBe(false)
  })

  it('is triggered by a high-frequency burst within the window', () => {
    const history = Array.from({ length: 8 }, (_, i) =>
      hist({ createdAt: new Date(NOW.getTime() - (i + 1) * 60 * 60 * 1000) })
    )
    const result = computeVelocityFeature(tx(), history, cfg)
    expect(result.triggered).toBe(true)
    expect(result.reasonCodes).toContain('VELOCITY_HIGH_FREQUENCY')
  })

  it('ignores transactions outside the velocity window', () => {
    const history = Array.from({ length: 8 }, () =>
      hist({ createdAt: new Date(NOW.getTime() - 30 * DAY) })
    )
    const result = computeVelocityFeature(tx(), history, cfg)
    expect(result.triggered).toBe(false)
  })

  it('detects a round-trip: withdrawal shortly after a deposit of a similar amount', () => {
    const history = [
      hist({
        type: 'DEPOSIT',
        amount: 1000,
        createdAt: new Date(NOW.getTime() - 30 * 60 * 1000),
      }),
    ]
    const result = computeVelocityFeature(
      tx({ type: 'WITHDRAWAL', amount: 1000 }),
      history,
      cfg
    )
    expect(result.reasonCodes).toContain('VELOCITY_ROUND_TRIP')
    expect(result.score).toBe(100)
  })

  it('does not flag a round-trip when the amount differs beyond tolerance', () => {
    const history = [
      hist({
        type: 'DEPOSIT',
        amount: 1000,
        createdAt: new Date(NOW.getTime() - 30 * 60 * 1000),
      }),
    ]
    const result = computeVelocityFeature(
      tx({ type: 'WITHDRAWAL', amount: 400 }),
      history,
      cfg
    )
    expect(result.reasonCodes).not.toContain('VELOCITY_ROUND_TRIP')
  })

  it('does not flag a round-trip outside the round-trip window', () => {
    const history = [
      hist({
        type: 'DEPOSIT',
        amount: 1000,
        createdAt: new Date(NOW.getTime() - 10 * DAY),
      }),
    ]
    const result = computeVelocityFeature(
      tx({ type: 'WITHDRAWAL', amount: 1000 }),
      history,
      cfg
    )
    expect(result.reasonCodes).not.toContain('VELOCITY_ROUND_TRIP')
  })

  it('is exempt for an agent-driven transaction regardless of history', () => {
    const history = Array.from({ length: 20 }, (_, i) =>
      hist({ createdAt: new Date(NOW.getTime() - (i + 1) * 60 * 1000) })
    )
    const result = computeVelocityFeature(
      tx({ isAgentDriven: true }),
      history,
      cfg
    )
    expect(result.triggered).toBe(false)
    expect(result.reasonCodes).toEqual(['AGENT_DRIVEN_EXEMPT'])
  })

  it('does not apply to non-money-movement transaction types', () => {
    const result = computeVelocityFeature(tx({ type: 'YIELD_CLAIM' }), [], cfg)
    expect(result.triggered).toBe(false)
  })
})

// ── STRUCTURING ──────────────────────────────────────────────────────────

describe('computeStructuringFeature', () => {
  const cfg = DEFAULT_SCORING_CONFIG.structuring // threshold 10_000, band 10%, minOccurrences 3

  it('is not triggered when the amount is not in the structuring band', () => {
    const result = computeStructuringFeature(tx({ amount: 500 }), [], cfg)
    expect(result.triggered).toBe(false)
  })

  it('is not triggered for a single in-band transaction with no repeats', () => {
    const result = computeStructuringFeature(tx({ amount: 9_500 }), [], cfg)
    expect(result.triggered).toBe(false)
  })

  it('is triggered by repeated in-band transactions within the window', () => {
    const history = [
      hist({ amount: 9_400, createdAt: new Date(NOW.getTime() - 1 * DAY) }),
      hist({ amount: 9_600, createdAt: new Date(NOW.getTime() - 2 * DAY) }),
    ]
    const result = computeStructuringFeature(
      tx({ amount: 9_500 }),
      history,
      cfg
    )
    expect(result.triggered).toBe(true)
    expect(result.reasonCodes).toContain('STRUCTURING_SUB_THRESHOLD_PATTERN')
  })

  it('does not count occurrences outside the structuring window', () => {
    const history = [
      hist({ amount: 9_400, createdAt: new Date(NOW.getTime() - 60 * DAY) }),
      hist({ amount: 9_600, createdAt: new Date(NOW.getTime() - 60 * DAY) }),
    ]
    const result = computeStructuringFeature(
      tx({ amount: 9_500 }),
      history,
      cfg
    )
    expect(result.triggered).toBe(false)
  })

  it('is exempt for an agent-driven transaction', () => {
    const history = [hist({ amount: 9_400 }), hist({ amount: 9_600 })]
    const result = computeStructuringFeature(
      tx({ amount: 9_500, isAgentDriven: true }),
      history,
      cfg
    )
    expect(result.reasonCodes).toEqual(['AGENT_DRIVEN_EXEMPT'])
  })
})

// ── NEW_DESTINATION ──────────────────────────────────────────────────────

describe('computeNewDestinationFeature', () => {
  const cfg = DEFAULT_SCORING_CONFIG.newDestination

  it('is not triggered when there is no destination address', () => {
    const result = computeNewDestinationFeature(
      tx({ destinationAddress: null }),
      account(),
      cfg
    )
    expect(result.triggered).toBe(false)
  })

  it('is not triggered for a known destination', () => {
    const result = computeNewDestinationFeature(
      tx({ destinationAddress: 'GABC' }),
      account({ knownDestinationAddresses: ['GABC'] }),
      cfg
    )
    expect(result.triggered).toBe(false)
  })

  it('is triggered (moderately) for a new destination with a small amount', () => {
    const result = computeNewDestinationFeature(
      tx({ destinationAddress: 'GNEW', amount: 100 }),
      account(),
      cfg
    )
    expect(result.triggered).toBe(true)
    expect(result.score).toBeLessThan(100)
    expect(result.reasonCodes).toContain('NEW_DESTINATION_NO_HISTORY')
  })

  it('saturates for a new destination with a large amount', () => {
    const result = computeNewDestinationFeature(
      tx({ destinationAddress: 'GNEW', amount: 1_000_000 }),
      account(),
      cfg
    )
    expect(result.score).toBe(100)
  })

  it('saturates and adds a reason code when the destination account is young', () => {
    const result = computeNewDestinationFeature(
      tx({ destinationAddress: 'GNEW', amount: 100 }),
      account({ destinationAccountAgeMs: DAY }),
      cfg
    )
    expect(result.score).toBe(100)
    expect(result.reasonCodes).toContain('NEW_DESTINATION_YOUNG_ACCOUNT')
  })
})

// ── ACCOUNT_AGE ──────────────────────────────────────────────────────────

describe('computeAccountAgeFeature', () => {
  const cfg = DEFAULT_SCORING_CONFIG.accountAge // 7d window

  it('is not triggered for an account well outside the new-account window', () => {
    const result = computeAccountAgeFeature(
      tx(),
      account({ accountCreatedAt: new Date(NOW.getTime() - 365 * DAY) }),
      cfg
    )
    expect(result.triggered).toBe(false)
  })

  it('scores at (near) 100 for a brand-new account', () => {
    const result = computeAccountAgeFeature(
      tx(),
      account({ accountCreatedAt: NOW }),
      cfg
    )
    expect(result.score).toBe(100)
    expect(result.reasonCodes).toContain('NEW_ACCOUNT')
  })

  it('decays linearly within the window', () => {
    const result = computeAccountAgeFeature(
      tx(),
      account({ accountCreatedAt: new Date(NOW.getTime() - 3.5 * DAY) }),
      cfg
    )
    expect(result.score).toBeCloseTo(50, 0)
  })
})

// ── SUB_ACCOUNT_FANOUT ───────────────────────────────────────────────────

describe('computeSubAccountFanOutFeature', () => {
  const cfg = DEFAULT_SCORING_CONFIG.subAccountFanOut // childCount 5, concentration 5

  it('is not triggered when the account has no sub-accounts', () => {
    const result = computeSubAccountFanOutFeature(account(), cfg)
    expect(result.triggered).toBe(false)
  })

  it('is not triggered below the child-count threshold', () => {
    const result = computeSubAccountFanOutFeature(
      account({ subAccount: { childCount: 2, recentChildDepositCount: 2 } }),
      cfg
    )
    expect(result.triggered).toBe(false)
  })

  it('is triggered by a mule-like fan-out pattern', () => {
    const result = computeSubAccountFanOutFeature(
      account({ subAccount: { childCount: 6, recentChildDepositCount: 6 } }),
      cfg
    )
    expect(result.triggered).toBe(true)
    expect(result.reasonCodes).toContain('SUB_ACCOUNT_FANOUT_MULE_PATTERN')
  })
})

// ── REFERRAL_GRAPH ───────────────────────────────────────────────────────

describe('computeReferralGraphFeature', () => {
  const cfg = DEFAULT_SCORING_CONFIG.referralGraph // 2_000 threshold

  it('is not triggered for a non-referred user', () => {
    const result = computeReferralGraphFeature(
      tx({ type: 'WITHDRAWAL', amount: 5_000 }),
      account({ referral: { isReferred: false, isFirstAction: true } }),
      cfg
    )
    expect(result.triggered).toBe(false)
  })

  it("is not triggered when it is not the referred user's first action", () => {
    const result = computeReferralGraphFeature(
      tx({ type: 'WITHDRAWAL', amount: 5_000 }),
      account({ referral: { isReferred: true, isFirstAction: false } }),
      cfg
    )
    expect(result.triggered).toBe(false)
  })

  it('is not triggered for a deposit (only withdrawals count)', () => {
    const result = computeReferralGraphFeature(
      tx({ type: 'DEPOSIT', amount: 5_000 }),
      account({ referral: { isReferred: true, isFirstAction: true } }),
      cfg
    )
    expect(result.triggered).toBe(false)
  })

  it('is triggered for a referred user whose first action is a large withdrawal', () => {
    const result = computeReferralGraphFeature(
      tx({ type: 'WITHDRAWAL', amount: 5_000 }),
      account({ referral: { isReferred: true, isFirstAction: true } }),
      cfg
    )
    expect(result.triggered).toBe(true)
    expect(result.score).toBe(100)
    expect(result.reasonCodes).toContain(
      'REFERRAL_FIRST_ACTION_LARGE_WITHDRAWAL'
    )
  })
})

// ── scoreTransaction (combinator) ───────────────────────────────────────

describe('scoreTransaction', () => {
  it('is deterministic: identical input produces identical output', () => {
    const context: TransactionContext = {
      transaction: tx({ amount: 9_500 }),
      account: account({
        transactionHistory: [hist({ amount: 9_400 }), hist({ amount: 9_600 })],
      }),
    }
    const a = scoreTransaction(context)
    const b = scoreTransaction(context)
    expect(a).toEqual(b)
  })

  it('carries the model version', () => {
    const result = scoreTransaction({ transaction: tx(), account: account() })
    expect(result.modelVersion).toBe(MODEL_VERSION)
  })

  it('the feature weights sum to 1.0', () => {
    const total = Object.values(DEFAULT_SCORING_CONFIG.weights).reduce(
      (sum, w) => sum + w,
      0
    )
    expect(total).toBeCloseTo(1, 10)
  })

  it('totalScore is the rounded weighted sum of feature contributions, bounded 0-100', () => {
    const result = scoreTransaction({
      transaction: tx({ destinationAddress: 'GNEW', amount: 1_000_000 }),
      account: account(),
    })
    const expected = Math.round(
      result.features.reduce((sum, f) => sum + f.contribution, 0)
    )
    expect(result.totalScore).toBe(expected)
    expect(result.totalScore).toBeGreaterThanOrEqual(0)
    expect(result.totalScore).toBeLessThanOrEqual(100)
  })

  it('a quiet, unremarkable transaction scores near 0', () => {
    const result = scoreTransaction({
      transaction: tx({ amount: 100 }),
      account: account({
        transactionHistory: [100, 95, 105, 98, 102, 101].map((amount) =>
          hist({ amount })
        ),
      }),
    })
    expect(result.totalScore).toBeLessThan(10)
  })

  it('flattens triggered reason codes from every feature', () => {
    const result = scoreTransaction({
      transaction: tx({ destinationAddress: 'GNEW', amount: 1_000_000 }),
      account: account(),
    })
    expect(result.reasonCodes).toContain('NEW_DESTINATION_NO_HISTORY')
    const newDest = feature(result, 'NEW_DESTINATION')
    expect(
      newDest.reasonCodes.every((c) => result.reasonCodes.includes(c))
    ).toBe(true)
  })

  it('accepts config overrides without mutating the shared default config', () => {
    const before = JSON.stringify(DEFAULT_SCORING_CONFIG)
    scoreTransaction(
      { transaction: tx(), account: account() },
      { amount: { lowZ: 0.1 } }
    )
    expect(JSON.stringify(DEFAULT_SCORING_CONFIG)).toBe(before)
  })

  it('a config override changes scoring behavior', () => {
    const history = [100, 95, 105, 98, 102, 101].map((amount) =>
      hist({ amount })
    )
    const context: TransactionContext = {
      transaction: tx({ amount: 102 }), // mild deviation, not enough to trigger default lowZ=2.5
      account: account({ transactionHistory: history }),
    }
    const defaultResult = feature(scoreTransaction(context), 'AMOUNT_ANOMALY')
    const sensitiveResult = feature(
      scoreTransaction(context, { amount: { lowZ: 0.1, highZ: 1 } }),
      'AMOUNT_ANOMALY'
    )
    expect(defaultResult.triggered).toBe(false)
    expect(sensitiveResult.triggered).toBe(true)
  })
})

// ── Agent-driven false-positive guard (issue's core edge case) ──────────

describe('scoreTransaction — agent rebalance does not false-positive', () => {
  it('an agent-driven rebalance with a rapid deposit/withdraw-like pattern scores low', () => {
    // Deliberately construct the exact shape that WOULD trigger velocity,
    // round-trip, and structuring if scored as user-driven: many rapid
    // same-asset transactions, including an opposite-direction match just
    // minutes before, all marked isAgentDriven. The transaction under test
    // is itself agent-driven too (the agent's own rebalance leg).
    const agentHistory: HistoricalTransaction[] = [
      hist({
        type: 'WITHDRAWAL',
        amount: 9_500,
        createdAt: new Date(NOW.getTime() - 5 * 60 * 1000),
        isAgentDriven: true,
      }),
      ...Array.from({ length: 10 }, (_, i) =>
        hist({
          type: i % 2 === 0 ? 'DEPOSIT' : 'WITHDRAWAL',
          amount: 9_500,
          createdAt: new Date(NOW.getTime() - (i + 1) * 10 * 60 * 1000),
          isAgentDriven: true,
        })
      ),
    ]

    const result = scoreTransaction({
      transaction: tx({
        type: 'DEPOSIT',
        amount: 9_500,
        isAgentDriven: true,
      }),
      account: account({ transactionHistory: agentHistory }),
    })

    const velocity = feature(result, 'VELOCITY')
    const structuring = feature(result, 'STRUCTURING')

    expect(velocity.triggered).toBe(false)
    expect(velocity.reasonCodes).toEqual(['AGENT_DRIVEN_EXEMPT'])
    expect(structuring.triggered).toBe(false)
    expect(structuring.reasonCodes).toEqual(['AGENT_DRIVEN_EXEMPT'])
    // Low overall — nothing about legitimate agent rebalancing should read as suspicious.
    expect(result.totalScore).toBeLessThan(15)
  })

  it("agent-driven history does not inflate a later user-driven transaction's velocity score", () => {
    // The account's agent has been rebalancing rapidly (10 legs in the last
    // hour) but the user has made no manual transactions at all. The user's
    // first real, manual deposit today must be judged on its own, not on the
    // agent's unrelated activity sitting in the same history array.
    const agentHistory: HistoricalTransaction[] = Array.from(
      { length: 10 },
      (_, i) =>
        hist({
          type: i % 2 === 0 ? 'DEPOSIT' : 'WITHDRAWAL',
          amount: 500,
          createdAt: new Date(NOW.getTime() - (i + 1) * 5 * 60 * 1000),
          isAgentDriven: true,
        })
    )

    const result = scoreTransaction({
      transaction: tx({ type: 'DEPOSIT', amount: 100, isAgentDriven: false }),
      account: account({ transactionHistory: agentHistory }),
    })

    const velocity = feature(result, 'VELOCITY')
    expect(velocity.triggered).toBe(false)
  })

  it('by contrast, the same rapid pattern DOES trigger when it is user-driven', () => {
    // Sanity check that the exemption is specific to isAgentDriven, not a
    // blanket "velocity never fires" bug.
    const userHistory: HistoricalTransaction[] = [
      hist({
        type: 'DEPOSIT',
        amount: 9_500,
        createdAt: new Date(NOW.getTime() - 30 * 60 * 1000),
        isAgentDriven: false,
      }),
    ]

    const result = scoreTransaction({
      transaction: tx({
        type: 'WITHDRAWAL',
        amount: 9_500,
        isAgentDriven: false,
      }),
      account: account({ transactionHistory: userHistory }),
    })

    const velocity = feature(result, 'VELOCITY')
    expect(velocity.triggered).toBe(true)
    expect(velocity.reasonCodes).toContain('VELOCITY_ROUND_TRIP')
  })
})
