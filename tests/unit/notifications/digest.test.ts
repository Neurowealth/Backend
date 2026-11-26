import {
  buildDigest,
  type DigestInput,
} from '../../../src/notifications/digest'

jest.mock('../../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}))

const DAY_MS = 24 * 60 * 60 * 1000

function fixedPeriod(daysAgo = 7): Date {
  const base = Date.UTC(2026, 0, 15, 12, 0, 0) // Jan 15 2026 12:00 UTC
  return new Date(base - daysAgo * DAY_MS)
}

function input(overrides: Partial<DigestInput> = {}): DigestInput {
  const now = fixedPeriod(0)
  const start = fixedPeriod(7)
  return {
    period: { label: 'Past 7 days', startAt: start, endAt: now },
    positions: [
      {
        id: 'pos-a',
        protocolName: 'Blend',
        assetSymbol: 'USDC',
        currentValue: 1100,
        depositedAmount: 1000,
        yieldEarned: 30,
      },
      {
        id: 'pos-b',
        protocolName: 'Luma',
        assetSymbol: 'USDC',
        currentValue: 500,
        depositedAmount: 400,
        yieldEarned: 45,
      },
    ],
    snapshots: [
      // start boundary
      {
        positionId: 'pos-a',
        value: 1000,
        apy: 5,
        timestampMs: start.getTime(),
      },
      { positionId: 'pos-b', value: 400, apy: 8, timestampMs: start.getTime() },
      // end boundary
      { positionId: 'pos-a', value: 1100, apy: 5, timestampMs: now.getTime() },
      { positionId: 'pos-b', value: 500, apy: 8, timestampMs: now.getTime() },
    ],
    transactions: [
      {
        type: 'DEPOSIT',
        amount: 150,
        assetSymbol: 'USDC',
        createdAt: new Date(now.getTime() - 2 * DAY_MS),
      },
    ],
    rebalances: [
      {
        fromProtocol: 'Blend',
        toProtocol: 'Luma',
        improvedByPercent: 0.5,
        createdAt: new Date(now.getTime() - 1 * DAY_MS),
      },
    ],
    goals: [
      {
        name: 'House deposit',
        targetAmount: 10000,
        progressPctStart: 10,
        progressPctNow: 16,
        onTrack: true,
        currentAmount: 1600,
      },
    ],
    caveats: [],
    notableTxnThreshold: 100,
    ...overrides,
  }
}

describe('buildDigest', () => {
  it('computes a normal portfolio digest deterministically', () => {
    const model = buildDigest(input())
    // end value = 1100 + 500
    expect(model.valueChange.endValue).toBe(1600)
    expect(model.valueChange.startValue).toBe(1400) // start boundary: 1000 + 400
    expect(model.valueChange.absoluteChange).toBe(200)
    expect(model.valueChange.percentChange).toBeCloseTo(14.29, 1)
    expect(model.valueChange.insufficientData).toBe(false)
    // yield earned over the period = (1100-1000) + (500-400)
    expect(model.yield.earned).toBe(200)
    expect(model.hasPositions).toBe(true)
    expect(model.caveats).toHaveLength(0)
  })

  it('reports agent rebalance count and net improvement', () => {
    const model = buildDigest(input())
    expect(model.rebalances.count).toBe(1)
    expect(model.rebalances.netImprovementPct).toBe(0.5)
    expect(model.rebalances.recent).toHaveLength(1)
  })

  it('lists same digest for identical inputs (pure/deterministic)', () => {
    const a = buildDigest(input())
    const b = buildDigest(input())
    expect(a).toEqual(b)
  })

  it('is honest about a gappy period (no start snapshot)', () => {
    const now = fixedPeriod(0)
    const start = fixedPeriod(7)
    const gappy = input({
      snapshots: [
        {
          positionId: 'pos-a',
          value: 1100,
          apy: 5,
          timestampMs: now.getTime(),
        },
        { positionId: 'pos-b', value: 500, apy: 8, timestampMs: now.getTime() },
      ],
    })
    const model = buildDigest(gappy)
    expect(model.valueChange.insufficientData).toBe(true)
    expect(model.valueChange.startValue).toBeNull()
    expect(model.valueChange.absoluteChange).toBeNull()
    expect(model.valueChange.percentChange).toBeNull()
    expect(
      model.caveats.some((c) => c.toLowerCase().includes('insufficient'))
    ).toBe(true)
  })

  it('is honest about a completely empty snapshot history', () => {
    const model = buildDigest(input({ snapshots: [] }))
    expect(model.valueChange.insufficientData).toBe(true)
    expect(model.caveats.length).toBeGreaterThan(0)
  })

  it('emits a short no-positions digest when the user has none', () => {
    const model = buildDigest(
      input({ positions: [], snapshots: [], goals: [], transactions: [] })
    )
    expect(model.hasPositions).toBe(false)
    expect(model.valueChange.endValue).toBe(0)
    expect(model.risk.text).toContain('No active positions')
    // No positions and no notable txns -> empty-ish message, not a crash.
    expect(model.notableTransactions).toHaveLength(0)
  })

  it('caps notable transactions and flags capReached', () => {
    const now = fixedPeriod(0)
    const txns = Array.from({ length: 20 }, (_, i) => ({
      type: 'DEPOSIT',
      amount: 200,
      assetSymbol: 'USDC',
      createdAt: new Date(now.getTime() - i * 60_000),
    }))
    const model = buildDigest(input({ transactions: txns }), 'WEEKLY', 5)
    expect(model.notableTransactions).toHaveLength(5)
    expect(model.capReached).toBe(true)
  })

  it('computes a risk line with a real drawdown', () => {
    const now = fixedPeriod(0)
    const start = fixedPeriod(7)
    // Value dips during the period then recovers.
    const snapshots = [
      { positionId: 'p', value: 1000, apy: 5, timestampMs: start.getTime() },
      {
        positionId: 'p',
        value: 920,
        apy: 5,
        timestampMs: start.getTime() + 2 * DAY_MS,
      },
      { positionId: 'p', value: 960, apy: 5, timestampMs: now.getTime() },
    ]
    const model = buildDigest(
      input({
        snapshots,
        positions: [
          {
            id: 'p',
            protocolName: 'Blend',
            assetSymbol: 'USDC',
            currentValue: 960,
            depositedAmount: 1000,
            yieldEarned: 0,
          },
        ],
      })
    )
    expect(model.risk.text).toMatch(/drawdown/i)
  })
})
