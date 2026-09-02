import fs from 'fs'
import path from 'path'
import {
  simulateImmediate,
  simulateHistorical,
  buildSimulationRateSeries,
  SIMULATE_MAX_WINDOW_DAYS,
  ImmediateSimulationResult,
  HistoricalSimulationResult,
} from '../../../src/agent/simulate'
import {
  buildDailyRateSeries,
  RawProtocolRatePoint,
} from '../../../src/agent/backtest'
import { EffectiveStrategyConfig } from '../../../src/agent/effectiveStrategy'
import { YieldProtocol } from '../../../src/agent/types'

jest.mock('../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

const DAY = 24 * 60 * 60 * 1000

function d(dateStr: string): Date {
  return new Date(dateStr + 'T00:00:00.000Z')
}

const defaultConfig: EffectiveStrategyConfig = {
  strategyName: 'MAX_YIELD',
}

function protocol(
  name: string,
  apy: number,
  isAvailable = true
): YieldProtocol {
  return {
    name,
    apy,
    assetSymbol: 'USDC',
    lastUpdated: d('2026-01-01'),
    isAvailable,
  }
}

// Flat 5% APY Blend for 10 days.
const flatFixture: RawProtocolRatePoint[] = Array.from(
  { length: 10 },
  (_, i) => ({
    protocolName: 'Blend',
    assetSymbol: 'USDC',
    apy: 5,
    date: new Date(d('2026-01-01').getTime() + i * DAY),
  })
)

describe('simulate.ts — structural guarantee', () => {
  it('src/agent/simulate.ts has zero imports from src/stellar', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../../src/agent/simulate.ts'),
      'utf-8'
    )
    const importLines = source
      .split('\n')
      .filter((line) => /^\s*import\b/.test(line))
    const stellarImports = importLines.filter((line) =>
      /['"].*stellar/i.test(line)
    )
    expect(stellarImports).toEqual([])
  })
})

describe('simulateImmediate — MAX_YIELD', () => {
  it('holds when the current protocol is already best and appetite matches', async () => {
    const result: ImmediateSimulationResult = await simulateImmediate({
      positions: [{ protocolName: 'Blend', currentValue: '5000' }],
      availableProtocols: [protocol('Blend', 5)],
      effectiveConfig: defaultConfig,
      thresholds: { minimumImprovement: 0.5, maxGasPercent: 0.1 },
      riskScores: {},
      asOf: d('2026-01-10'),
    })
    expect(result.action).toBe('hold')
    expect(result.targetProtocol).toBeNull()
    expect(result.moves).toEqual([])
    expect(result.reasoning.length).toBeGreaterThan(0)
  })

  it('recommends a rebalance to a materially higher-yield protocol for a large position', async () => {
    const result: ImmediateSimulationResult = await simulateImmediate({
      positions: [{ protocolName: 'Blend', currentValue: '50000' }],
      availableProtocols: [protocol('Blend', 5), protocol('Luma', 20)],
      effectiveConfig: defaultConfig,
      thresholds: { minimumImprovement: 0.5, maxGasPercent: 0.1 },
      riskScores: {},
      asOf: d('2026-01-10'),
    })
    expect(result.action).toBe('rebalance')
    expect(result.targetProtocol).toBe('Luma')
  })

  it('returns blocked for GOAL_TRACKING with no active goal', async () => {
    const result: ImmediateSimulationResult = await simulateImmediate({
      positions: [{ protocolName: 'Blend', currentValue: '5000' }],
      availableProtocols: [protocol('Blend', 5)],
      effectiveConfig: { ...defaultConfig, strategyName: 'GOAL_TRACKING' },
      thresholds: { minimumImprovement: 0.5, maxGasPercent: 0.1 },
      riskScores: {},
      asOf: d('2026-01-10'),
    })
    expect(result.action).toBe('blocked')
    expect(result.reasoning).toMatch(/active savings goal/i)
  })

  it('ignores a higher-yield protocol above the risk ceiling', async () => {
    const result: ImmediateSimulationResult = await simulateImmediate({
      positions: [{ protocolName: 'Blend', currentValue: '50000' }],
      availableProtocols: [protocol('Blend', 5), protocol('Luma', 20)],
      effectiveConfig: { ...defaultConfig, riskCeiling: 50 },
      thresholds: { minimumImprovement: 0.5, maxGasPercent: 0.1 },
      riskScores: { Blend: 60, Luma: 20 },
      asOf: d('2026-01-10'),
    })
    expect(result.action).toBe('hold')
    expect(result.targetProtocol).toBeNull()
    const luma = result.trace.candidates?.find((c) => c.protocol === 'Luma')
    expect(luma?.rejectionReason).toBe('over_risk_ceiling')
  })

  it('returns hold with reasoning for empty positions', async () => {
    const result: ImmediateSimulationResult = await simulateImmediate({
      positions: [],
      availableProtocols: [protocol('Blend', 5)],
      effectiveConfig: defaultConfig,
      thresholds: { minimumImprovement: 0.5, maxGasPercent: 0.1 },
      riskScores: {},
      asOf: d('2026-01-10'),
    })
    expect(result.action).toBe('hold')
    expect(result.reasoning).toMatch(/no active positions/i)
  })
})

describe('simulateHistorical — MAX_YIELD flat rate', () => {
  it('is deterministic: identical inputs yield identical results', async () => {
    const { series } = buildDailyRateSeries(
      flatFixture,
      d('2026-01-01'),
      d('2026-01-10')
    )
    const input = {
      dailyRates: series,
      effectiveConfig: defaultConfig,
      startingAmount: '1000',
      startingProtocol: 'Blend',
      riskScores: {},
      userId: 'user-1',
    }

    const first = await simulateHistorical(input)
    const second = await simulateHistorical(input)
    expect(second).toEqual(first)
  })

  it('accrues 10 days of simple daily return with no rebalance at a flat 5% APY', async () => {
    const { series } = buildDailyRateSeries(
      flatFixture,
      d('2026-01-01'),
      d('2026-01-10')
    )
    const result: HistoricalSimulationResult = await simulateHistorical({
      dailyRates: series,
      effectiveConfig: defaultConfig,
      startingAmount: '1000',
      startingProtocol: 'Blend',
      riskScores: {},
      userId: 'user-1',
    })

    const dailyReturn = (5 / 100 / 365.25) * 1000
    const expectedFinal = 1000 + dailyReturn * 10
    expect(Number(result.endingValue)).toBeCloseTo(expectedFinal, 2)
    expect(result.rebalanceCount).toBe(0)
    expect(result.totalFeesPaid).toBe('0')
    expect(result.finalProtocol).toBe('Blend')
    // No rebalance -> simulated and counterfactual legs are identical.
    expect(result.counterfactualEndingValue).toBe(result.endingValue)
    expect(result.timeSeries).toHaveLength(10)
  })

  it('records rebalances, fees, and a differing counterfactual when a much better protocol appears', async () => {
    const points: RawProtocolRatePoint[] = [
      ...flatFixture,
      ...Array.from({ length: 5 }, (_, i) => ({
        protocolName: 'Luma',
        assetSymbol: 'USDC',
        apy: 20,
        date: new Date(d('2026-01-05').getTime() + i * DAY),
      })),
    ]
    const { series } = buildDailyRateSeries(
      points,
      d('2026-01-01'),
      d('2026-01-10')
    )
    const result: HistoricalSimulationResult = await simulateHistorical({
      dailyRates: series,
      effectiveConfig: defaultConfig,
      startingAmount: '100000',
      startingProtocol: 'Blend',
      riskScores: {},
      userId: 'user-1',
    })

    expect(result.rebalanceCount).toBeGreaterThan(0)
    expect(result.finalProtocol).toBe('Luma')
    expect(result.totalFeesPaid).not.toBe('0')
    // Rebalancing incurs a fee, so by construction the legs differ.
    expect(result.counterfactualEndingValue).not.toBe(result.endingValue)
  })

  it('returns zero ending value for a zero starting amount', async () => {
    const { series } = buildDailyRateSeries(
      flatFixture,
      d('2026-01-01'),
      d('2026-01-10')
    )
    const result: HistoricalSimulationResult = await simulateHistorical({
      dailyRates: series,
      effectiveConfig: defaultConfig,
      startingAmount: '0',
      startingProtocol: 'Blend',
      riskScores: {},
      userId: 'user-1',
    })
    expect(result.endingValue).toBe('0')
    expect(result.counterfactualEndingValue).toBe('0')
  })
})

describe('buildSimulationRateSeries — window bounds', () => {
  it('truncates the window to available retention and reports a caveat', () => {
    const { series, dataCaveats } = buildSimulationRateSeries(
      flatFixture,
      d('2026-01-01'),
      new Date(d('2026-01-01').getTime() + 180 * DAY),
      SIMULATE_MAX_WINDOW_DAYS
    )
    // Only the 10 retained days are replayed, never extrapolated beyond data.
    expect(series.length).toBe(10)
    expect(dataCaveats.some((c) => /retained history ends/i.test(c))).toBe(true)
  })

  it('surfaces a cap caveat when the window exceeds the simulation cap', () => {
    const { dataCaveats } = buildSimulationRateSeries(
      flatFixture,
      d('2026-01-01'),
      new Date(d('2026-01-01').getTime() + 365 * DAY),
      SIMULATE_MAX_WINDOW_DAYS
    )
    expect(dataCaveats.some((c) => /simulation cap/i.test(c))).toBe(true)
  })
})
