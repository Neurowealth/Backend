/**
 * Unit tests for Fiat Transaction Limits, Velocity Controls & KYC-Tier Enforcement (#362).
 */
import {
  evaluateFiatOrder,
  computeFiatLimitsSummary,
  evaluateScheduledFiatRun,
  DEFAULT_FIAT_LIMIT_POLICIES,
  HOUR_MS,
  DAY_MS,
  type HistoricalFiatOrder,
  type ScheduledFiatPlanState,
} from '../../../src/fiat/limits'

describe('evaluateFiatOrder (#362)', () => {
  const now = new Date('2026-10-27T12:00:00.000Z')

  it('checks compliance freeze (#321) FIRST before tier or limits', () => {
    const res = evaluateFiatOrder({
      userId: 'user-1',
      direction: 'ON_RAMP',
      amount: 50,
      currency: 'USD',
      tier: 'TIER_3',
      recentOrders: [],
      now,
      isFrozen: true,
    })

    expect(res.allowed).toBe(false)
    expect(res.reason).toBe('compliance_freeze')
  })

  it('denies TIER_0 users with tier_zero reason', () => {
    const res = evaluateFiatOrder({
      userId: 'user-1',
      direction: 'ON_RAMP',
      amount: 10,
      currency: 'USD',
      tier: 'TIER_0',
      recentOrders: [],
      now,
    })

    expect(res.allowed).toBe(false)
    expect(res.reason).toBe('tier_zero')
    expect(res.limit).toBe(0)
  })

  it('enforces per_txn limit and stricter offRampOverrides for OFF_RAMP', () => {
    // TIER_1 on-ramp perTxnMax is $1,000; off-ramp perTxnMax is $500
    const onRampAllowed = evaluateFiatOrder({
      userId: 'user-1',
      direction: 'ON_RAMP',
      amount: 800,
      currency: 'USD',
      tier: 'TIER_1',
      recentOrders: [],
      now,
    })
    expect(onRampAllowed.allowed).toBe(true)

    const offRampDenied = evaluateFiatOrder({
      userId: 'user-1',
      direction: 'OFF_RAMP',
      amount: 800,
      currency: 'USD',
      tier: 'TIER_1',
      recentOrders: [],
      now,
    })
    expect(offRampDenied.allowed).toBe(false)
    expect(offRampDenied.reason).toBe('per_txn')
    expect(offRampDenied.limit).toBe(500)

    const onRampDenied = evaluateFiatOrder({
      userId: 'user-1',
      direction: 'ON_RAMP',
      amount: 1200,
      currency: 'USD',
      tier: 'TIER_1',
      recentOrders: [],
      now,
    })
    expect(onRampDenied.allowed).toBe(false)
    expect(onRampDenied.reason).toBe('per_txn')
    expect(onRampDenied.limit).toBe(1000)
  })

  it('enforces rolling 1-hour velocity (velocity_hourly) and computes retryAfter', () => {
    // TIER_1 allows maxTxnsPerHour = 3
    const recentOrders: HistoricalFiatOrder[] = [
      {
        fiatAmount: 100,
        fiatCurrency: 'USD',
        status: 'SETTLED',
        createdAt: new Date(now.getTime() - 50 * 60 * 1000),
      },
      {
        fiatAmount: 100,
        fiatCurrency: 'USD',
        status: 'PROCESSING',
        createdAt: new Date(now.getTime() - 30 * 60 * 1000),
      },
      {
        fiatAmount: 100,
        fiatCurrency: 'USD',
        status: 'PENDING',
        createdAt: new Date(now.getTime() - 10 * 60 * 1000),
      },
    ]

    const res = evaluateFiatOrder({
      userId: 'user-1',
      direction: 'ON_RAMP',
      amount: 100,
      currency: 'USD',
      tier: 'TIER_1',
      recentOrders,
      now,
    })

    expect(res.allowed).toBe(false)
    expect(res.reason).toBe('velocity_hourly')
    expect(res.limit).toBe(3)
    expect(res.used).toBe(3)
    expect(res.remaining).toBe(0)
    // Oldest order was 50m ago, so it ages out of the 1h window in 10m (600s)
    expect(res.retryAfter).toBe(600)
  })

  it('enforces rolling 24-hour velocity (velocity_daily) across midnight boundaries', () => {
    // TIER_1 allows maxTxnsPerDay = 10, maxTxnsPerHour = 3
    // Spread 10 orders across the last 20 hours (at most 1 every 2 hours so hourly velocity is fine)
    const recentOrders: HistoricalFiatOrder[] = Array.from(
      { length: 10 },
      (_, i) => ({
        fiatAmount: 50,
        fiatCurrency: 'USD',
        status: 'SETTLED',
        createdAt: new Date(now.getTime() - (20 - i * 2) * HOUR_MS),
      })
    )

    const res = evaluateFiatOrder({
      userId: 'user-1',
      direction: 'ON_RAMP',
      amount: 50,
      currency: 'USD',
      tier: 'TIER_1',
      recentOrders,
      now,
    })

    expect(res.allowed).toBe(false)
    expect(res.reason).toBe('velocity_daily')
    expect(res.limit).toBe(10)
    expect(res.used).toBe(10)
    expect(res.remaining).toBe(0)
    expect(res.retryAfter).toBeGreaterThan(0)
  })

  it('enforces rolling 24-hour volume cap (daily) and rolling 30-day volume cap (monthly)', () => {
    // TIER_1 dailyMax = $2,500, monthlyMax = $10,000
    const recentDailyOrders: HistoricalFiatOrder[] = [
      {
        fiatAmount: 1000,
        fiatCurrency: 'USD',
        status: 'SETTLED',
        createdAt: new Date(now.getTime() - 10 * HOUR_MS),
      },
      {
        fiatAmount: 1000,
        fiatCurrency: 'USD',
        status: 'PENDING',
        createdAt: new Date(now.getTime() - 5 * HOUR_MS),
      },
    ]

    const dailyDenied = evaluateFiatOrder({
      userId: 'user-1',
      direction: 'ON_RAMP',
      amount: 600,
      currency: 'USD',
      tier: 'TIER_1',
      recentOrders: recentDailyOrders,
      now,
    })
    expect(dailyDenied.allowed).toBe(false)
    expect(dailyDenied.reason).toBe('daily')
    expect(dailyDenied.limit).toBe(2500)
    expect(dailyDenied.used).toBe(2000)
    expect(dailyDenied.remaining).toBe(500)

    // Spread $9,500 across days 3..15 ago so daily used is $0 but monthly used is $9,500
    const recentMonthlyOrders: HistoricalFiatOrder[] = Array.from(
      { length: 10 },
      (_, i) => ({
        fiatAmount: 950,
        fiatCurrency: 'USD',
        status: 'SETTLED',
        createdAt: new Date(now.getTime() - (3 + i) * DAY_MS),
      })
    )

    const monthlyDenied = evaluateFiatOrder({
      userId: 'user-1',
      direction: 'ON_RAMP',
      amount: 600,
      currency: 'USD',
      tier: 'TIER_1',
      recentOrders: recentMonthlyOrders,
      now,
    })
    expect(monthlyDenied.allowed).toBe(false)
    expect(monthlyDenied.reason).toBe('monthly')
    expect(monthlyDenied.limit).toBe(10000)
    expect(monthlyDenied.used).toBe(9500)
    expect(monthlyDenied.remaining).toBe(500)
  })

  it('reserves headroom for PENDING orders in a burst (10 concurrent attempts, only N fit) and releases when FAILED', () => {
    // TIER_1: maxTxnsPerHour = 3, perTxnMax = 1000, dailyMax = 2500
    const orderHistory: HistoricalFiatOrder[] = []
    let allowedCount = 0
    let deniedCount = 0

    for (let i = 0; i < 10; i++) {
      const evalRes = evaluateFiatOrder({
        userId: 'user-burst',
        direction: 'ON_RAMP',
        amount: 500,
        currency: 'USD',
        tier: 'TIER_1',
        recentOrders: orderHistory,
        now,
      })
      if (evalRes.allowed) {
        allowedCount++
        // Immediately record as PENDING in history
        orderHistory.push({
          id: `pending-${i}`,
          fiatAmount: 500,
          fiatCurrency: 'USD',
          status: 'PENDING',
          createdAt: now,
        })
      } else {
        deniedCount++
      }
    }

    expect(allowedCount).toBe(3)
    expect(deniedCount).toBe(7)

    // Now one of the PENDING orders fails 1 minute later -> headroom is released as of failure time
    const failTime = new Date(now.getTime() + 60_000)
    orderHistory[0].status = 'FAILED'
    orderHistory[0].updatedAt = failTime

    const afterFailEval = evaluateFiatOrder({
      userId: 'user-burst',
      direction: 'ON_RAMP',
      amount: 500,
      currency: 'USD',
      tier: 'TIER_1',
      recentOrders: orderHistory,
      now: failTime,
    })
    expect(afterFailEval.allowed).toBe(true)
  })

  it('releases REFUNDED order headroom as of refund time without retroactively rewriting prior window state', () => {
    const orderCreated = new Date('2026-10-05T10:00:00.000Z')
    const refundTime = new Date('2026-10-15T10:00:00.000Z')

    const refundedOrder: HistoricalFiatOrder = {
      id: 'ord-refunded',
      fiatAmount: 9500,
      fiatCurrency: 'USD',
      status: 'REFUNDED',
      createdAt: orderCreated,
      updatedAt: refundTime,
      refundedAt: refundTime,
    }

    // Evaluating at 2026-10-10 (BEFORE refundTime): the order was still active/settled then, so it counted!
    const beforeRefund = evaluateFiatOrder({
      userId: 'user-1',
      direction: 'ON_RAMP',
      amount: 800,
      currency: 'USD',
      tier: 'TIER_1',
      recentOrders: [refundedOrder],
      now: new Date('2026-10-10T10:00:00.000Z'),
    })
    expect(beforeRefund.allowed).toBe(false)
    expect(beforeRefund.reason).toBe('monthly')

    // Evaluating at 2026-10-16 (AFTER refundTime): headroom is released as of refundTime!
    const afterRefund = evaluateFiatOrder({
      userId: 'user-1',
      direction: 'ON_RAMP',
      amount: 800,
      currency: 'USD',
      tier: 'TIER_1',
      recentOrders: [refundedOrder],
      now: new Date('2026-10-16T10:00:00.000Z'),
    })
    expect(afterRefund.allowed).toBe(true)
  })

  it('converts cross-currency orders via FX feed (rateSource: FX_FEED) and fails closed when FX feed is down', () => {
    // 920 EUR at 0.92 EUR/USD = 1,000 USD (fits TIER_1 perTxnMax = 1000)
    const allowedCrossCcy = evaluateFiatOrder({
      userId: 'user-1',
      direction: 'ON_RAMP',
      amount: 920,
      currency: 'EUR',
      tier: 'TIER_1',
      recentOrders: [],
      now,
    })
    expect(allowedCrossCcy.allowed).toBe(true)
    expect(allowedCrossCcy.rateSource).toBe('FX_FEED')
    expect(allowedCrossCcy.baseAmount).toBeCloseTo(1000, 1)

    // 950 EUR > 1,000 USD -> denied by per_txn
    const deniedCrossCcy = evaluateFiatOrder({
      userId: 'user-1',
      direction: 'ON_RAMP',
      amount: 950,
      currency: 'EUR',
      tier: 'TIER_1',
      recentOrders: [],
      now,
    })
    expect(deniedCrossCcy.allowed).toBe(false)
    expect(deniedCrossCcy.reason).toBe('per_txn')

    // FX feed down -> fail closed with fx_unavailable
    const fxDown = evaluateFiatOrder({
      userId: 'user-1',
      direction: 'ON_RAMP',
      amount: 100,
      currency: 'EUR',
      tier: 'TIER_1',
      recentOrders: [],
      now,
      fxFeedAvailable: false,
    })
    expect(fxDown.allowed).toBe(false)
    expect(fxDown.reason).toBe('fx_unavailable')

    // Unknown currency -> fail closed with fx_unavailable
    const unknownCcy = evaluateFiatOrder({
      userId: 'user-1',
      direction: 'ON_RAMP',
      amount: 100,
      currency: 'ZZZ',
      tier: 'TIER_1',
      recentOrders: [],
      now,
    })
    expect(unknownCcy.allowed).toBe(false)
    expect(unknownCcy.reason).toBe('fx_unavailable')
  })

  it('attaches a soft limitWarning when an allowed order pushes a window above LIMIT_SOFT_WARN_PCT', () => {
    // TIER_1 dailyMax = 2500; prior 24h used = 1500; new order = 600 -> 2100 / 2500 = 84% (> 80%)
    const res = evaluateFiatOrder({
      userId: 'user-1',
      direction: 'ON_RAMP',
      amount: 600,
      currency: 'USD',
      tier: 'TIER_1',
      recentOrders: [
        {
          fiatAmount: 1000,
          fiatCurrency: 'USD',
          status: 'SETTLED',
          createdAt: new Date(now.getTime() - 4 * HOUR_MS),
        },
        {
          fiatAmount: 500,
          fiatCurrency: 'USD',
          status: 'SETTLED',
          createdAt: new Date(now.getTime() - 2 * HOUR_MS),
        },
      ],
      now,
    })

    expect(res.allowed).toBe(true)
    expect(res.limitWarning).toBeDefined()
    expect(res.limitWarning?.window).toBe('daily')
    expect(res.limitWarning?.utilizationPct).toBe(84)
  })

  it('auto-pauses a scheduled fiat plan after N consecutive skipped_limit runs', () => {
    let plan: ScheduledFiatPlanState = {
      id: 'plan-1',
      userId: 'user-1',
      status: 'ACTIVE',
      consecutiveSkippedLimit: 0,
    }

    for (let i = 1; i <= 3; i++) {
      const run = evaluateScheduledFiatRun({
        plan,
        maxConsecutiveSkips: 3,
        evaluationInput: {
          userId: 'user-1',
          direction: 'ON_RAMP',
          amount: 1500, // exceeds TIER_1 perTxnMax = 1000
          currency: 'USD',
          tier: 'TIER_1',
          recentOrders: [],
          now,
        },
      })
      expect(run.outcome).toBe('skipped_limit')
      expect(run.consecutiveSkippedLimit).toBe(i)
      if (i < 3) {
        expect(run.shouldAutoPause).toBe(false)
        expect(run.nextStatus).toBe('ACTIVE')
      } else {
        expect(run.shouldAutoPause).toBe(true)
        expect(run.nextStatus).toBe('PAUSED')
      }
      plan = {
        ...plan,
        status: run.nextStatus,
        consecutiveSkippedLimit: run.consecutiveSkippedLimit,
      }
    }
  })

  it('computes caller limits summary for GET /api/v1/fiat/limits', () => {
    const summary = computeFiatLimitsSummary({
      tier: 'TIER_2',
      direction: 'ON_RAMP',
      recentOrders: [
        {
          fiatAmount: 2000,
          fiatCurrency: 'USD',
          status: 'SETTLED',
          createdAt: new Date(now.getTime() - 20 * 60 * 1000),
        },
      ],
      now,
      policy: DEFAULT_FIAT_LIMIT_POLICIES.TIER_2,
    })

    expect(summary.tier).toBe('TIER_2')
    expect(summary.currency).toBe('USD')
    expect(summary.windows.daily.limit).toBe(25000)
    expect(summary.windows.daily.used).toBe(2000)
    expect(summary.windows.daily.remaining).toBe(23000)
    expect(summary.windows.velocityHourly.used).toBe(1)
    expect(summary.windows.velocityHourly.remaining).toBe(4)
  })
})
