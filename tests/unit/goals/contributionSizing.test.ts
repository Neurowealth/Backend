import {
  computeContribution,
  countRemainingRuns,
  evaluateBalanceFallback,
  previewGoalCatchUpRuns,
  DEFAULT_AHEAD_FLOOR_FRACTION,
} from '../../../src/goals/contributionSizing'

describe('goal-linked contributionSizing (#357)', () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  // Exactly 4 weeks (28 days) ahead -> 4 weekly runs (run at now + 3 weekly steps)
  const fourWeeksOut = new Date('2026-01-29T00:00:00.000Z')

  describe('countRemainingRuns', () => {
    it('counts remaining weekly runs from now through targetDate and recomputes on cadence change', () => {
      expect(countRemainingRuns(now, fourWeeksOut, 'WEEKLY')).toBe(5)
      expect(countRemainingRuns(now, fourWeeksOut, 'BIWEEKLY')).toBe(3)
      expect(countRemainingRuns(now, fourWeeksOut, 'MONTHLY')).toBe(1)
    })

    it('returns 1 when targetDate is at or before now', () => {
      expect(countRemainingRuns(now, now, 'WEEKLY')).toBe(1)
    })
  })

  describe('computeContribution — behind, ahead, clamped, horizons', () => {
    it('SPREAD_REMAINING amortizes shortfall across remaining runs', () => {
      // currentAmount=1000, actualApy=0, baseAmount=100, remainingRuns=5 -> scheduled=500 -> projected=1500
      // targetAmount=1800 -> shortfall=300 -> spread adjustment = 300/5 = 60 -> next contribution = 160
      const res = computeContribution({
        goal: {
          targetAmount: 1800,
          targetDate: fourWeeksOut,
        },
        currentAmount: 1000,
        actualApy: 0,
        cadence: 'WEEKLY',
        now,
        mode: 'GOAL_CATCH_UP',
        horizon: 'SPREAD_REMAINING',
        baseAmount: 100,
        bounds: { minAmount: 50, maxAmount: 300 },
      })

      expect(res.remainingRuns).toBe(5)
      expect(res.projectedValue).toBe(1500)
      expect(res.shortfall).toBe(300)
      expect(res.amount).toBe(160)
      expect(res.clampedBy).toBeNull()
      expect(res.onTrackAfterRun).toBe(true)
      expect(res.stillShortAfterRun).toBe(false)
    })

    it('NEXT_RUN adds the entire shortfall to the next contribution', () => {
      const res = computeContribution({
        goal: {
          targetAmount: 1800,
          targetDate: fourWeeksOut,
        },
        currentAmount: 1000,
        actualApy: 0,
        cadence: 'WEEKLY',
        now,
        mode: 'GOAL_CATCH_UP',
        horizon: 'NEXT_RUN',
        baseAmount: 100,
        bounds: { minAmount: 50, maxAmount: 500 },
      })

      expect(res.shortfall).toBe(300)
      expect(res.amount).toBe(400)
      expect(res.clampedBy).toBeNull()
      expect(res.onTrackAfterRun).toBe(true)
    })

    it('clamps to maxAmount when required catch-up exceeds upper bound and flags stillShortAfterRun', () => {
      const res = computeContribution({
        goal: {
          targetAmount: 2500,
          targetDate: fourWeeksOut,
        },
        currentAmount: 1000,
        actualApy: 0,
        cadence: 'WEEKLY',
        now,
        mode: 'GOAL_CATCH_UP',
        horizon: 'SPREAD_REMAINING',
        baseAmount: 100,
        bounds: { minAmount: 50, maxAmount: 200 },
      })

      // projected=1500, shortfall=1000, unclamped = 100 + 1000/5 = 300 > maxAmount(200)
      expect(res.unclampedAmount).toBe(300)
      expect(res.amount).toBe(200)
      expect(res.clampedBy).toBe('max')
      expect(res.stillShortAfterRun).toBe(true)
      expect(res.onTrackAfterRun).toBe(false)
    })

    it('ahead of target (shortfall < 0): reduces toward explicit minAmount and clamps at min', () => {
      // currentAmount=1600, baseAmount=100, remainingRuns=5 -> projected=2100, target=1800 -> shortfall=-300
      // unclamped SPREAD_REMAINING = 100 + (-300/5) = 40 < minAmount(60) -> clamped to 60
      const res = computeContribution({
        goal: {
          targetAmount: 1800,
          targetDate: fourWeeksOut,
        },
        currentAmount: 1600,
        actualApy: 0,
        cadence: 'WEEKLY',
        now,
        mode: 'GOAL_CATCH_UP',
        horizon: 'SPREAD_REMAINING',
        baseAmount: 100,
        bounds: { minAmount: 60, maxAmount: 300 },
      })

      expect(res.shortfall).toBe(-300)
      expect(res.unclampedAmount).toBe(40)
      expect(res.amount).toBe(60)
      expect(res.clampedBy).toBe('min')
    })

    it('ahead of target with unset minAmount: floors at DEFAULT_AHEAD_FLOOR_FRACTION of baseAmount', () => {
      const res = computeContribution({
        goal: {
          targetAmount: 1800,
          targetDate: fourWeeksOut,
        },
        currentAmount: 1800,
        actualApy: 0,
        cadence: 'WEEKLY',
        now,
        mode: 'GOAL_CATCH_UP',
        horizon: 'SPREAD_REMAINING',
        baseAmount: 100,
        bounds: { minAmount: null, maxAmount: 300 },
      })

      // projected=2300, shortfall=-500 -> unclamped = 100 - 100 = 0 -> floors at 25% of 100 = 25
      expect(res.amount).toBe(100 * DEFAULT_AHEAD_FLOOR_FRACTION)
      expect(res.clampedBy).toBe('min')
    })

    it('accounts for non-compounding actualApy growth when available and documents caveat when unavailable', () => {
      const oneYearOut = new Date(now.getTime() + 365.25 * 24 * 60 * 60 * 1000)
      const withApy = computeContribution({
        goal: { targetAmount: 2000, targetDate: oneYearOut },
        currentAmount: 1000,
        actualApy: 10, // 10% over 1 year -> 1000 grows to 1100
        cadence: 'MONTHLY',
        now,
        mode: 'GOAL_CATCH_UP',
        horizon: 'NEXT_RUN',
        baseAmount: 50,
        bounds: { maxAmount: 1000 },
      })

      expect(withApy.projectionBasis.projectedFromCurrent).toBeCloseTo(1100, 2)
      expect(withApy.projectionBasis.apySource).toBe('actual')
      expect(withApy.projectionBasis.caveat).toBeNull()

      const withoutApy = computeContribution({
        goal: { targetAmount: 2000, targetDate: oneYearOut },
        currentAmount: 1000,
        actualApy: null,
        cadence: 'MONTHLY',
        now,
        mode: 'GOAL_CATCH_UP',
        horizon: 'NEXT_RUN',
        baseAmount: 50,
        bounds: { maxAmount: 1000 },
      })

      expect(withoutApy.projectionBasis.projectedFromCurrent).toBe(1000)
      expect(withoutApy.projectionBasis.apySource).toBe('zero_fallback')
      expect(withoutApy.projectionBasis.caveat).toContain('0% APY')
    })
  })

  describe('evaluateBalanceFallback', () => {
    it('returns FULL when availableBalance covers derivedAmount', () => {
      const res = evaluateBalanceFallback({
        derivedAmount: 150,
        availableBalance: 200,
        minAmount: 50,
      })
      expect(res.action).toBe('FULL')
      expect(res.appliedAmount).toBe(150)
      expect(res.lastRunStatus).toBe('executed')
    })

    it('degrades to PARTIAL when availableBalance is between minAmount and derivedAmount', () => {
      const res = evaluateBalanceFallback({
        derivedAmount: 150,
        availableBalance: 80,
        minAmount: 50,
      })
      expect(res.action).toBe('PARTIAL')
      expect(res.appliedAmount).toBe(80)
      expect(res.lastRunStatus).toBe('executed_partial_balance')
    })

    it('skips with skipped_insufficient_balance when availableBalance is below minAmount', () => {
      const res = evaluateBalanceFallback({
        derivedAmount: 150,
        availableBalance: 30,
        minAmount: 50,
      })
      expect(res.action).toBe('SKIP')
      expect(res.appliedAmount).toBe(0)
      expect(res.lastRunStatus).toBe('skipped_insufficient_balance')
    })
  })

  describe('previewGoalCatchUpRuns', () => {
    it('projects N runs and reports days late when maxAmount is too low to catch up on time', () => {
      const preview = previewGoalCatchUpRuns({
        planId: 'plan-1',
        goalId: 'goal-1',
        goal: {
          targetAmount: 2500,
          targetDate: fourWeeksOut,
        },
        currentAmount: 1000,
        actualApy: 0,
        cadence: 'WEEKLY',
        baseAmount: 100,
        sizingMode: 'GOAL_CATCH_UP',
        horizon: 'SPREAD_REMAINING',
        bounds: { minAmount: 50, maxAmount: 200 },
        runs: 6,
        now,
      })

      expect(preview.runsCount).toBe(6)
      expect(preview.isSimulation).toBe(true)
      expect(preview.onTrackWithCurrentBounds).toBe(false)
      expect(preview.daysLate).toBeGreaterThan(0)
      expect(preview.completionSummary).toContain('days late')
    })
  })
})
