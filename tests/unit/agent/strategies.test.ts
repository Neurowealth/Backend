import {
  MaxYieldStrategy,
  TargetAllocationStrategy,
  NO_ELIGIBLE_PROTOCOLS_REASON,
} from '../../../src/agent/strategies'
import { StrategyParams, YieldProtocol } from '../../../src/agent/types'

jest.mock('../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

function makeProtocol(overrides: Partial<YieldProtocol> = {}): YieldProtocol {
  return {
    name: 'TestProtocol',
    apy: 5.0,
    assetSymbol: 'USDC',
    lastUpdated: new Date(),
    isAvailable: true,
    ...overrides,
  }
}

const defaultThresholds = {
  minimumImprovement: 0.5,
  maxGasPercent: 0.1,
}

describe('MaxYieldStrategy', () => {
  const strategy = new MaxYieldStrategy()

  it('returns strategy name as MAX_YIELD', () => {
    expect(strategy.name).toBe('MAX_YIELD')
  })

  it('recommends rebalance when a better protocol exists and net gain exceeds threshold', async () => {
    // Use 10000 USDC so gas costs (~$0.50) are negligible (0.005%)
    const params: StrategyParams = {
      currentProtocol: 'Blend',
      totalAmount: '10000000000000000000000',
      currentApy: 3.0,
      availableProtocols: [
        makeProtocol({ name: 'Luma', apy: 8.0 }),
        makeProtocol({ name: 'Blend', apy: 3.0 }),
      ],
      thresholds: defaultThresholds,
      userStrategyPreferences: [],
    }

    const decision = await strategy.analyze(params)
    expect(decision.shouldRebalance).toBe(true)
    expect(decision.targetProtocol).toBe('Luma')
    expect(decision.reasoning).toContain('Luma')
    expect(decision.deviationTrigger).toContain('APY delta')
    expect(decision.details).toBeDefined()
  })

  it('does NOT rebalance when current protocol is already the best', async () => {
    const params: StrategyParams = {
      currentProtocol: 'Blend',
      totalAmount: '10000000000000000000',
      currentApy: 8.0,
      availableProtocols: [
        makeProtocol({ name: 'Blend', apy: 8.0 }),
        makeProtocol({ name: 'Luma', apy: 5.0 }),
      ],
      thresholds: defaultThresholds,
      userStrategyPreferences: [],
    }

    const decision = await strategy.analyze(params)
    expect(decision.shouldRebalance).toBe(false)
    expect(decision.targetProtocol).toBe('Blend')
    expect(decision.reasoning).toContain('Already on the highest-yielding')
  })

  it('does NOT rebalance when net improvement is below threshold', async () => {
    const params: StrategyParams = {
      currentProtocol: 'Blend',
      totalAmount: '10000000000000000000',
      currentApy: 7.8,
      availableProtocols: [
        makeProtocol({ name: 'Luma', apy: 8.0 }),
        makeProtocol({ name: 'Blend', apy: 7.8 }),
      ],
      thresholds: defaultThresholds,
      userStrategyPreferences: [],
    }

    const decision = await strategy.analyze(params)
    expect(decision.shouldRebalance).toBe(false)
    expect(decision.reasoning).toContain('below threshold')
  })

  it('does NOT rebalance when no protocols are available', async () => {
    const params: StrategyParams = {
      currentProtocol: 'Blend',
      totalAmount: '10000000000000000000',
      currentApy: 5.0,
      availableProtocols: [],
      thresholds: defaultThresholds,
      userStrategyPreferences: [],
    }

    const decision = await strategy.analyze(params)
    expect(decision.shouldRebalance).toBe(false)
    expect(decision.reasoning).toContain('No protocols available')
  })

  it('handles very small amounts without crashing', async () => {
    const params: StrategyParams = {
      currentProtocol: 'Blend',
      totalAmount: '1',
      currentApy: 3.0,
      availableProtocols: [makeProtocol({ name: 'Luma', apy: 8.0 })],
      thresholds: defaultThresholds,
      userStrategyPreferences: [],
    }

    const decision = await strategy.analyze(params)
    expect(decision.shouldRebalance).toBe(false)
    expect(decision.reasoning).toBeDefined()
  })
})

describe('TargetAllocationStrategy', () => {
  const strategy = new TargetAllocationStrategy()

  it('returns strategy name as TARGET_ALLOCATION', () => {
    expect(strategy.name).toBe('TARGET_ALLOCATION')
  })

  it('recommends rebalance when protocol has significantly lower target than the preferred protocol', async () => {
    const params: StrategyParams = {
      currentProtocol: 'Blend',
      totalAmount: '10000000000000000000000',
      currentApy: 5.0,
      availableProtocols: [
        makeProtocol({ name: 'Luma', apy: 6.0 }),
        makeProtocol({ name: 'Blend', apy: 5.0 }),
      ],
      thresholds: defaultThresholds,
      userStrategyPreferences: [
        {
          userId: 'user-1',
          strategyName: 'TARGET_ALLOCATION',
          targetAllocations: { Blend: 30, 'Stellar DEX': 40, Luma: 30 },
        },
      ],
    }

    const decision = await strategy.analyze(params)
    expect(decision.shouldRebalance).toBe(true)
    expect(decision.targetProtocol).toBe('Stellar DEX')
    expect(decision.reasoning).toContain('significantly below')
    expect(decision.deviationTrigger).toContain('Target ratio')
    expect(decision.details).toBeDefined()
  })

  it('does NOT rebalance when targets are within acceptable range of each other', async () => {
    const params: StrategyParams = {
      currentProtocol: 'Blend',
      totalAmount: '10000000000000000000',
      currentApy: 5.0,
      availableProtocols: [
        makeProtocol({ name: 'Luma', apy: 6.0 }),
        makeProtocol({ name: 'Blend', apy: 5.0 }),
      ],
      thresholds: defaultThresholds,
      userStrategyPreferences: [
        {
          userId: 'user-1',
          strategyName: 'TARGET_ALLOCATION',
          targetAllocations: { Blend: 33, 'Stellar DEX': 33, Luma: 34 },
        },
      ],
    }

    const decision = await strategy.analyze(params)
    expect(decision.shouldRebalance).toBe(false)
    expect(decision.reasoning).toContain('within acceptable range')
  })

  it('does NOT rebalance when no target allocations configured', async () => {
    const params: StrategyParams = {
      currentProtocol: 'Blend',
      totalAmount: '10000000000000000000',
      currentApy: 5.0,
      availableProtocols: [makeProtocol({ name: 'Luma', apy: 6.0 })],
      thresholds: defaultThresholds,
      userStrategyPreferences: [
        { userId: 'user-1', strategyName: 'TARGET_ALLOCATION' },
      ],
    }

    const decision = await strategy.analyze(params)
    expect(decision.shouldRebalance).toBe(false)
    expect(decision.reasoning).toContain('No target allocations configured')
  })

  it('does NOT rebalance when no preferences match', async () => {
    const params: StrategyParams = {
      currentProtocol: 'Blend',
      totalAmount: '10000000000000000000',
      currentApy: 5.0,
      availableProtocols: [makeProtocol({ name: 'Luma', apy: 6.0 })],
      thresholds: defaultThresholds,
      userStrategyPreferences: [],
    }

    const decision = await strategy.analyze(params)
    expect(decision.shouldRebalance).toBe(false)
    expect(decision.reasoning).toContain('No target allocations configured')
  })

  it('does NOT rebalance when current protocol has no target', async () => {
    const params: StrategyParams = {
      currentProtocol: 'UnknownProtocol',
      totalAmount: '10000000000000000000',
      currentApy: 5.0,
      availableProtocols: [makeProtocol({ name: 'Luma', apy: 6.0 })],
      thresholds: defaultThresholds,
      userStrategyPreferences: [
        {
          userId: 'user-1',
          strategyName: 'TARGET_ALLOCATION',
          targetAllocations: { Blend: 50, Luma: 50 },
        },
      ],
    }

    const decision = await strategy.analyze(params)
    expect(decision.shouldRebalance).toBe(false)
    expect(decision.reasoning).toContain('No target allocation set')
  })
})

// ── Risk ceiling (issue #291) ────────────────────────────────────────────────
//
// The ceiling is a genuine safety control on where user funds can go. These
// tests guard two things the issue calls out explicitly:
//   1. Backward compatibility — a user who never sets a ceiling must see
//      byte-for-byte identical decisions to before the parameter existed.
//   2. The ceiling is NEVER silently bypassed: when it excludes every protocol
//      the strategy surfaces an explicit "no eligible protocols" state rather
//      than falling back to allocating somewhere the user disallowed.

describe('MaxYieldStrategy — riskCeiling', () => {
  const strategy = new MaxYieldStrategy()

  const baseParams = (): StrategyParams => ({
    currentProtocol: 'Blend',
    totalAmount: '10000000000000000000000',
    currentApy: 3.0,
    availableProtocols: [
      makeProtocol({ name: 'Luma', apy: 8.0 }),
      makeProtocol({ name: 'Blend', apy: 3.0 }),
    ],
    thresholds: defaultThresholds,
    userStrategyPreferences: [],
  })

  it('is a no-op when riskCeiling is undefined (identical decision to before)', async () => {
    const params = baseParams()
    // Even if scores are supplied, an unset ceiling must ignore them entirely.
    params.protocolRiskScores = { Luma: 10, Blend: 10 }

    const withoutCeiling = await strategy.analyze(baseParams())
    const withScoresButNoCeiling = await strategy.analyze(params)

    expect(withScoresButNoCeiling).toEqual(withoutCeiling)
    expect(withScoresButNoCeiling.shouldRebalance).toBe(true)
    expect(withScoresButNoCeiling.targetProtocol).toBe('Luma')
  })

  it('filters out protocols below the ceiling before optimizing for yield', async () => {
    const params = baseParams()
    params.riskCeiling = 50
    // Luma is the highest yield but too risky; a lower-yield protocol clears it.
    params.availableProtocols = [
      makeProtocol({ name: 'Luma', apy: 8.0 }),
      makeProtocol({ name: 'Stellar DEX', apy: 6.0 }),
      makeProtocol({ name: 'Blend', apy: 3.0 }),
    ]
    params.protocolRiskScores = { Luma: 20, 'Stellar DEX': 70, Blend: 80 }

    const decision = await strategy.analyze(params)
    expect(decision.shouldRebalance).toBe(true)
    // Must NOT pick Luma even though it has the best APY.
    expect(decision.targetProtocol).toBe('Stellar DEX')
  })

  it('surfaces an explicit "no eligible protocols" state rather than bypassing the ceiling', async () => {
    const params = baseParams()
    params.riskCeiling = 90
    params.protocolRiskScores = { Luma: 20, Blend: 30 } // nothing clears 90

    const decision = await strategy.analyze(params)
    expect(decision.shouldRebalance).toBe(false)
    expect(decision.targetProtocol).toBe('Blend') // stays put, no silent move
    expect(decision.reasoning).toBe(NO_ELIGIBLE_PROTOCOLS_REASON)
  })

  it('fail-closed: a protocol with no known score is excluded under a ceiling', async () => {
    const params = baseParams()
    params.riskCeiling = 50
    // Luma has a passing score; Blend (current) has no score at all.
    params.protocolRiskScores = { Luma: 70 }

    const decision = await strategy.analyze(params)
    // Luma is eligible and higher yield -> rebalance to it.
    expect(decision.shouldRebalance).toBe(true)
    expect(decision.targetProtocol).toBe('Luma')
  })

  it('fail-closed: when scores are entirely absent, a ceiling excludes everything', async () => {
    const params = baseParams()
    params.riskCeiling = 50
    params.protocolRiskScores = undefined

    const decision = await strategy.analyze(params)
    expect(decision.shouldRebalance).toBe(false)
    expect(decision.reasoning).toBe(NO_ELIGIBLE_PROTOCOLS_REASON)
  })
})

describe('TargetAllocationStrategy — riskCeiling', () => {
  const strategy = new TargetAllocationStrategy()

  const baseParams = (): StrategyParams => ({
    currentProtocol: 'Blend',
    totalAmount: '10000000000000000000000',
    currentApy: 5.0,
    availableProtocols: [
      makeProtocol({ name: 'Luma', apy: 6.0 }),
      makeProtocol({ name: 'Blend', apy: 5.0 }),
    ],
    thresholds: defaultThresholds,
    userStrategyPreferences: [
      {
        userId: 'user-1',
        strategyName: 'TARGET_ALLOCATION',
        targetAllocations: { Blend: 30, 'Stellar DEX': 40, Luma: 30 },
      },
    ],
  })

  it('is a no-op when riskCeiling is undefined (identical decision to before)', async () => {
    const params = baseParams()
    params.protocolRiskScores = { Blend: 10, 'Stellar DEX': 10, Luma: 10 }

    const withoutCeiling = await strategy.analyze(baseParams())
    const withScoresButNoCeiling = await strategy.analyze(params)

    expect(withScoresButNoCeiling).toEqual(withoutCeiling)
    expect(withScoresButNoCeiling.shouldRebalance).toBe(true)
    expect(withScoresButNoCeiling.targetProtocol).toBe('Stellar DEX')
  })

  it('excludes target protocols below the ceiling before choosing a rebalance target', async () => {
    const params = baseParams()
    params.riskCeiling = 50
    // Weight Luma above the current protocol so a rebalance is warranted once
    // the higher-weighted Stellar DEX is excluded by the ceiling.
    params.userStrategyPreferences = [
      {
        userId: 'user-1',
        strategyName: 'TARGET_ALLOCATION',
        targetAllocations: { Blend: 20, 'Stellar DEX': 40, Luma: 40 },
      },
    ]
    // Stellar DEX has the highest target weight but fails the ceiling; Luma clears it.
    params.protocolRiskScores = { Blend: 80, 'Stellar DEX': 20, Luma: 70 }

    const decision = await strategy.analyze(params)
    expect(decision.shouldRebalance).toBe(true)
    expect(decision.targetProtocol).toBe('Luma')
  })

  it('surfaces "no eligible protocols" when the ceiling excludes every target', async () => {
    const params = baseParams()
    params.riskCeiling = 90
    params.protocolRiskScores = { Blend: 95, 'Stellar DEX': 20, Luma: 30 }

    const decision = await strategy.analyze(params)
    expect(decision.shouldRebalance).toBe(false)
    expect(decision.targetProtocol).toBe('Blend')
    expect(decision.reasoning).toBe(NO_ELIGIBLE_PROTOCOLS_REASON)
  })
})
