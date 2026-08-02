import fs from 'fs'
import path from 'path'
import {
  buildDailyRateSeries,
  runBacktest,
  RawProtocolRatePoint,
} from '../../../src/agent/backtest'
import {
  buildCacheKey,
  getCached,
  setCached,
  clearBacktestCache,
} from '../../../src/agent/backtestCache'

import {
  MaxYieldStrategy,
  TargetAllocationStrategy,
} from '../../../src/agent/strategies'

jest.mock('../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

const DAY = 24 * 60 * 60 * 1000

function d(dateStr: string): Date {
  return new Date(dateStr + 'T00:00:00.000Z')
}

// Fixed synthetic fixture: Blend flat at 5% APY for the whole window.
const flatFixture: RawProtocolRatePoint[] = Array.from(
  { length: 10 },
  (_, i) => ({
    protocolName: 'Blend',
    assetSymbol: 'USDC',
    apy: 5,
    date: new Date(d('2026-01-01').getTime() + i * DAY),
  })
)

describe('backtest engine — structural guarantee', () => {
  it('src/agent/backtest.ts has zero imports from src/stellar', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../../src/agent/backtest.ts'),
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

describe('buildDailyRateSeries — gap handling (hold-previous-value)', () => {
  it('forward-fills a protocol across a gap in its rate history', () => {
    const points: RawProtocolRatePoint[] = [
      {
        protocolName: 'Blend',
        assetSymbol: 'USDC',
        apy: 5,
        date: d('2026-01-01'),
      },
      // Gap on 01-02 — no observation for Blend that day.
      {
        protocolName: 'Blend',
        assetSymbol: 'USDC',
        apy: 6,
        date: d('2026-01-03'),
      },
    ]

    const { series } = buildDailyRateSeries(
      points,
      d('2026-01-01'),
      d('2026-01-03')
    )

    expect(series).toHaveLength(3)
    expect(series[0].protocols[0].apy).toBe(5) // 01-01: real observation
    expect(series[1].protocols[0].apy).toBe(5) // 01-02: held forward
    expect(series[2].protocols[0].apy).toBe(6) // 01-03: new observation
  })

  it('excludes a protocol entirely before its first observation', () => {
    const points: RawProtocolRatePoint[] = [
      {
        protocolName: 'Blend',
        assetSymbol: 'USDC',
        apy: 5,
        date: d('2026-01-01'),
      },
      {
        protocolName: 'Luma',
        assetSymbol: 'USDC',
        apy: 9,
        date: d('2026-01-03'),
      },
    ]

    const { series } = buildDailyRateSeries(
      points,
      d('2026-01-01'),
      d('2026-01-03')
    )

    expect(series[0].protocols.map((p) => p.name)).toEqual(['Blend'])
    expect(series[1].protocols.map((p) => p.name)).toEqual(['Blend'])
    expect(series[2].protocols.map((p) => p.name).sort()).toEqual([
      'Blend',
      'Luma',
    ])
  })

  it('reports the earliest available date across all protocols', () => {
    const points: RawProtocolRatePoint[] = [
      {
        protocolName: 'Blend',
        assetSymbol: 'USDC',
        apy: 5,
        date: d('2026-02-01'),
      },
      {
        protocolName: 'Luma',
        assetSymbol: 'USDC',
        apy: 9,
        date: d('2026-01-15'),
      },
    ]
    const { earliestAvailableDate } = buildDailyRateSeries(
      points,
      d('2026-01-15'),
      d('2026-02-01')
    )
    expect(earliestAvailableDate?.toISOString().slice(0, 10)).toBe('2026-01-15')
  })

  it('returns an empty series and null earliest date with no observations', () => {
    const { series, earliestAvailableDate } = buildDailyRateSeries(
      [],
      d('2026-01-01'),
      d('2026-01-05')
    )
    expect(series).toEqual([])
    expect(earliestAvailableDate).toBeNull()
  })
})

describe('runBacktest — known-output fixture', () => {
  it('produces a monotonically increasing value series at a flat 5% APY with a single protocol', async () => {
    const { series } = buildDailyRateSeries(
      flatFixture,
      d('2026-01-01'),
      d('2026-01-10')
    )
    const outcome = await runBacktest(new MaxYieldStrategy(), series, {
      strategyName: 'MAX_YIELD',
      startDate: d('2026-01-01'),
      endDate: d('2026-01-10'),
      startingAmount: 1000,
    })

    expect(outcome.status).toBe('ok')
    if (outcome.status !== 'ok') return

    expect(outcome.result.timeSeries).toHaveLength(10)
    expect(outcome.result.rebalanceEvents).toEqual([])
    expect(outcome.result.finalProtocol).toBe('Blend')

    // Known expected output: 10 days of simple daily accrual at 5%/365.25 on 1000.
    const dailyReturn = (5 / 100 / 365.25) * 1000
    const expectedFinal = 1000 + dailyReturn * 10
    expect(outcome.result.summary.finalValue).toBeCloseTo(expectedFinal, 2)
    expect(outcome.result.summary.maxDrawdownPercent).toBe(0) // monotonically increasing
  })

  it('rebalances into a materially better protocol when one becomes available', async () => {
    const points: RawProtocolRatePoint[] = [
      ...flatFixture,
      // Luma appears halfway through at a much higher APY.
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

    const outcome = await runBacktest(new MaxYieldStrategy(), series, {
      strategyName: 'MAX_YIELD',
      startDate: d('2026-01-01'),
      endDate: d('2026-01-10'),
      startingAmount: 10000, // large enough that gas cost doesn't block the rebalance
    })

    expect(outcome.status).toBe('ok')
    if (outcome.status !== 'ok') return
    expect(outcome.result.rebalanceEvents.length).toBeGreaterThan(0)
    expect(outcome.result.rebalanceEvents[0].toProtocol).toBe('Luma')
    expect(outcome.result.finalProtocol).toBe('Luma')
  })

  it('returns insufficient_history when there is no rate data at all', async () => {
    const outcome = await runBacktest(new MaxYieldStrategy(), [], {
      strategyName: 'MAX_YIELD',
      startDate: d('2026-01-01'),
      endDate: d('2026-01-10'),
      startingAmount: 1000,
    })
    expect(outcome.status).toBe('insufficient_history')
  })

  it('rejects a non-positive startingAmount', async () => {
    const { series } = buildDailyRateSeries(
      flatFixture,
      d('2026-01-01'),
      d('2026-01-10')
    )
    const outcome = await runBacktest(new MaxYieldStrategy(), series, {
      strategyName: 'MAX_YIELD',
      startDate: d('2026-01-01'),
      endDate: d('2026-01-10'),
      startingAmount: 0,
    })
    expect(outcome.status).toBe('invalid_range')
  })

  it('supports TargetAllocationStrategy over the same fixture shape', async () => {
    const points: RawProtocolRatePoint[] = [
      ...flatFixture,
      ...Array.from({ length: 10 }, (_, i) => ({
        protocolName: 'Stellar DEX',
        assetSymbol: 'USDC',
        apy: 7,
        date: new Date(d('2026-01-01').getTime() + i * DAY),
      })),
    ]
    const { series } = buildDailyRateSeries(
      points,
      d('2026-01-01'),
      d('2026-01-10')
    )

    const outcome = await runBacktest(new TargetAllocationStrategy(), series, {
      strategyName: 'TARGET_ALLOCATION',
      startDate: d('2026-01-01'),
      endDate: d('2026-01-10'),
      startingAmount: 10000,
      userStrategyPreferences: [
        {
          userId: 'user-1',
          strategyName: 'TARGET_ALLOCATION',
          targetAllocations: { Blend: 20, 'Stellar DEX': 80 },
        },
      ],
    })

    expect(outcome.status).toBe('ok')
  })
})

describe('backtest result caching', () => {
  beforeEach(() => clearBacktestCache())

  it('produces the same cache key for identical requests', () => {
    const req = {
      strategyName: 'MAX_YIELD' as const,
      startDate: d('2026-01-01'),
      endDate: d('2026-01-10'),
      startingAmount: 1000,
    }
    expect(buildCacheKey(req)).toBe(buildCacheKey({ ...req }))
  })

  it('produces different cache keys for different requests', () => {
    const base = {
      strategyName: 'MAX_YIELD' as const,
      startDate: d('2026-01-01'),
      endDate: d('2026-01-10'),
      startingAmount: 1000,
    }
    expect(buildCacheKey(base)).not.toBe(
      buildCacheKey({ ...base, startingAmount: 2000 })
    )
  })

  it('a second identical request is served from cache without recomputing', async () => {
    const { series } = buildDailyRateSeries(
      flatFixture,
      d('2026-01-01'),
      d('2026-01-10')
    )
    const request = {
      strategyName: 'MAX_YIELD' as const,
      startDate: d('2026-01-01'),
      endDate: d('2026-01-10'),
      startingAmount: 1000,
    }
    const key = buildCacheKey(request)

    expect(getCached(key)).toBeUndefined()

    const analyzeSpy = jest.spyOn(MaxYieldStrategy.prototype, 'analyze')
    const strategy = new MaxYieldStrategy()
    const outcome = await runBacktest(strategy, series, request)
    setCached(key, outcome)

    const callsAfterFirstRun = analyzeSpy.mock.calls.length
    expect(callsAfterFirstRun).toBeGreaterThan(0)

    // Simulate the route handler's cache-hit path: it must return the
    // cached outcome WITHOUT calling runBacktest (and therefore without
    // calling strategy.analyze) again.
    const cachedOutcome = getCached(key)
    expect(cachedOutcome).toEqual(outcome)
    expect(analyzeSpy.mock.calls.length).toBe(callsAfterFirstRun) // unchanged — no recompute

    analyzeSpy.mockRestore()
  })
})
