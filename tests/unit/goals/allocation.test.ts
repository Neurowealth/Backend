import {
  attributeContribution,
  attributeYield,
  attributeWithdrawal,
  reconcileUserGoalAllocations,
  selectBindingGoal,
  sortGoalsByPriority,
  type AllocatableGoal,
} from '../../../src/goals/allocation'

describe('src/goals/allocation.ts (#358)', () => {
  const futureDate = (daysFromNow: number) =>
    new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000)

  describe('sortGoalsByPriority (deterministic tie-breaking)', () => {
    it('orders by priority ASC, then targetDate ASC, then createdAt ASC, then id ASC', () => {
      const t1 = new Date('2027-01-01T00:00:00Z')
      const t2 = new Date('2027-06-01T00:00:00Z')
      const c1 = new Date('2026-01-01T00:00:00Z')
      const c2 = new Date('2026-02-01T00:00:00Z')

      const goals: AllocatableGoal[] = [
        {
          id: 'g-low-prio',
          priority: 200,
          targetAmount: 1000,
          targetDate: t1,
          createdAt: c1,
        },
        {
          id: 'g-tie-later-created',
          priority: 10,
          targetAmount: 1000,
          targetDate: t1,
          createdAt: c2,
        },
        {
          id: 'g-tie-earlier-created',
          priority: 10,
          targetAmount: 1000,
          targetDate: t1,
          createdAt: c1,
        },
        {
          id: 'g-later-deadline',
          priority: 10,
          targetAmount: 1000,
          targetDate: t2,
          createdAt: c1,
        },
      ]

      const sorted = sortGoalsByPriority(goals)
      expect(sorted.map((g) => g.id)).toEqual([
        'g-tie-earlier-created',
        'g-tie-later-created',
        'g-later-deadline',
        'g-low-prio',
      ])
    })
  })

  describe('attributeContribution', () => {
    it('SEQUENTIAL: funds highest-priority goal first and cascades overflow to next goals', () => {
      const goals: AllocatableGoal[] = [
        {
          id: 'goal-2',
          priority: 20,
          targetAmount: 1000,
          currentAmount: 200,
          targetDate: futureDate(180),
          status: 'ACTIVE',
        },
        {
          id: 'goal-1',
          priority: 10,
          targetAmount: 500,
          currentAmount: 300,
          targetDate: futureDate(90),
          status: 'ACTIVE',
        },
      ]

      // goal-1 needs 200 to hit 500; remaining 450 goes to goal-2 (needs 800)
      const res = attributeContribution({
        amount: 650,
        goals,
        mode: 'SEQUENTIAL',
      })

      expect(res.allocations).toEqual([
        { goalId: 'goal-1', amount: 200, decimalAmount: '200' },
        { goalId: 'goal-2', amount: 450, decimalAmount: '450' },
      ])
      expect(res.totalAllocated).toBe(650)
      expect(res.unallocated).toBe(0)
    })

    it('SEQUENTIAL: puts excess beyond all active targets into unallocated and skips ACHIEVED goals', () => {
      const goals: AllocatableGoal[] = [
        {
          id: 'goal-achieved',
          priority: 1,
          targetAmount: 500,
          currentAmount: 500,
          targetDate: futureDate(60),
          status: 'ACHIEVED',
        },
        {
          id: 'goal-active',
          priority: 10,
          targetAmount: 1000,
          currentAmount: 700,
          targetDate: futureDate(120),
          status: 'ACTIVE',
        },
      ]

      const res = attributeContribution({
        amount: 500,
        goals,
        mode: 'SEQUENTIAL',
      })

      expect(res.allocations).toEqual([
        { goalId: 'goal-achieved', amount: 0, decimalAmount: '0' },
        { goalId: 'goal-active', amount: 300, decimalAmount: '300' },
      ])
      expect(res.totalAllocated).toBe(300)
      expect(res.unallocated).toBe(200)
    })

    it('WEIGHTED: splits proportionally by allocationWeight and cascades overflow when a goal caps out', () => {
      const goals: AllocatableGoal[] = [
        {
          id: 'goal-small-cap',
          priority: 10,
          allocationWeight: 3, // 75% initial weight, but only 100 headroom left!
          targetAmount: 500,
          currentAmount: 400,
          targetDate: futureDate(90),
          status: 'ACTIVE',
        },
        {
          id: 'goal-large-cap',
          priority: 20,
          allocationWeight: 1, // 25% initial weight, 2000 headroom left
          targetAmount: 2000,
          currentAmount: 0,
          targetDate: futureDate(365),
          status: 'ACTIVE',
        },
      ]

      // Contribute 400: 75% of 400 is 300, which exceeds goal-small-cap's 100 headroom.
      // goal-small-cap gets capped at 100, and the remaining 300 cascades to goal-large-cap!
      const res = attributeContribution({
        amount: 400,
        goals,
        mode: 'WEIGHTED',
      })

      expect(res.allocations).toEqual([
        { goalId: 'goal-small-cap', amount: 100, decimalAmount: '100' },
        { goalId: 'goal-large-cap', amount: 300, decimalAmount: '300' },
      ])
      expect(res.totalAllocated).toBe(400)
      expect(res.unallocated).toBe(0)
    })
  })

  describe('attributeYield', () => {
    it('attributes yield proportional to each active goal current attributed balance', () => {
      const goals: AllocatableGoal[] = [
        {
          id: 'goal-a',
          priority: 10,
          targetAmount: 5000,
          currentAmount: 3000, // 75% of attributed capital
          targetDate: futureDate(365),
          status: 'ACTIVE',
        },
        {
          id: 'goal-b',
          priority: 20,
          targetAmount: 5000,
          currentAmount: 1000, // 25% of attributed capital
          targetDate: futureDate(365),
          status: 'ACTIVE',
        },
        {
          id: 'goal-achieved',
          priority: 5,
          targetAmount: 1000,
          currentAmount: 1000,
          targetDate: futureDate(30),
          status: 'ACHIEVED',
        },
      ]

      const res = attributeYield({ yieldAmount: 200, goals })
      expect(res.allocations).toEqual([
        { goalId: 'goal-achieved', amount: 0, decimalAmount: '0' },
        { goalId: 'goal-a', amount: 150, decimalAmount: '150' },
        { goalId: 'goal-b', amount: 50, decimalAmount: '50' },
      ])
      expect(res.totalAllocated).toBe(200)
      expect(res.unallocated).toBe(0)
    })
  })

  describe('attributeWithdrawal', () => {
    it('reduces attributed capital in reverse funding order (lowest priority first) and clamps at 0', () => {
      const goals: AllocatableGoal[] = [
        {
          id: 'emergency-fund',
          priority: 10,
          targetAmount: 2000,
          currentAmount: 1000,
          targetDate: futureDate(90),
          status: 'ACTIVE',
        },
        {
          id: 'vacation-fund',
          priority: 50,
          targetAmount: 1000,
          currentAmount: 400,
          targetDate: futureDate(180),
          status: 'ACTIVE',
        },
      ]

      const res = attributeWithdrawal({
        withdrawalAmount: 600,
        goals,
      })

      // vacation-fund (priority 50) loses all 400 first, then emergency-fund (priority 10) loses 200
      expect(res.reductions).toEqual([
        { goalId: 'emergency-fund', amount: -200, decimalAmount: '-200' },
        { goalId: 'vacation-fund', amount: -400, decimalAmount: '-400' },
      ])
      expect(res.totalReduced).toBe(600)
      expect(res.unallocatedReduction).toBe(0)
    })

    it('prioritizes position-scoped goals when positionId is provided on withdrawal', () => {
      const goals: AllocatableGoal[] = [
        {
          id: 'scoped-high-prio',
          priority: 10,
          positionId: 'pos-special',
          targetAmount: 1000,
          currentAmount: 500,
          targetDate: futureDate(90),
          status: 'ACTIVE',
        },
        {
          id: 'unscoped-low-prio',
          priority: 90,
          positionId: null,
          targetAmount: 1000,
          currentAmount: 500,
          targetDate: futureDate(90),
          status: 'ACTIVE',
        },
      ]

      const res = attributeWithdrawal({
        withdrawalAmount: 300,
        goals,
        positionId: 'pos-special',
      })

      expect(res.reductions).toEqual([
        { goalId: 'scoped-high-prio', amount: -300, decimalAmount: '-300' },
        { goalId: 'unscoped-low-prio', amount: 0, decimalAmount: '0' },
      ])
    })
  })

  describe('reconcileUserGoalAllocations', () => {
    it('reconciles per-goal sums and absorbs remainder into unallocated', () => {
      const rec = reconcileUserGoalAllocations({
        totalPortfolioAmount: 1000.000001,
        goals: [
          { id: 'g1', attributedAmount: 600 },
          { id: 'g2', attributedAmount: 350 },
        ],
      })

      expect(rec.totalAttributed).toBe(950)
      expect(rec.unallocated).toBeCloseTo(50.000001, 6)
      expect(
        rec.goals.reduce((s, g) => s + g.currentAmount, 0) + rec.unallocated
      ).toBeCloseTo(rec.totalPortfolioAmount, 6)
    })
  })

  describe('selectBindingGoal', () => {
    it('single-goal backward-compat: returns exact startingAmount, targetAmount, targetDate, and riskCeiling', () => {
      const now = new Date('2026-01-01T00:00:00Z')
      const targetDate = new Date('2027-01-01T00:00:00Z')
      const selection = selectBindingGoal(
        [
          {
            id: 'only-goal',
            targetAmount: 12000,
            startingAmount: 10000,
            currentAmount: 10500,
            targetDate,
            riskCeiling: 65,
            status: 'ACTIVE',
          },
        ],
        now
      )

      expect(selection).not.toBeNull()
      expect(selection!.bindingGoal.id).toBe('only-goal')
      expect(selection!.bindingGoal.startingAmount).toBe(10000)
      expect(selection!.bindingGoal.targetAmount).toBe(12000)
      expect(selection!.effectiveRiskCeiling).toBe(65)
    })

    it('multi-goal: picks the under-funded goal with highest requiredApy and enforces the stricter (max) riskCeiling', () => {
      const now = new Date('2026-01-01T00:00:00Z')
      const oneYearOut = new Date('2027-01-01T00:00:00Z')

      const selection = selectBindingGoal(
        [
          {
            id: 'easy-goal',
            priority: 10,
            targetAmount: 1050,
            startingAmount: 1000,
            currentAmount: 1000, // needs 5% APY
            targetDate: oneYearOut,
            riskCeiling: 60,
            status: 'ACTIVE',
          },
          {
            id: 'hard-goal',
            priority: 50,
            targetAmount: 1250,
            startingAmount: 1000,
            currentAmount: 1000, // needs 25% APY -> binding!
            targetDate: oneYearOut,
            riskCeiling: 40,
            status: 'ACTIVE',
          },
          {
            id: 'conservative-funded-goal',
            priority: 30,
            targetAmount: 1020,
            startingAmount: 1000,
            currentAmount: 1000, // needs 2% APY, but has riskCeiling 80 (strictest!)
            targetDate: oneYearOut,
            riskCeiling: 80,
            status: 'ACTIVE',
          },
        ],
        now
      )

      expect(selection).not.toBeNull()
      expect(selection!.bindingGoal.id).toBe('hard-goal')
      expect(selection!.bindingGoal.targetAmount).toBe(1250)
      // Stricter ceiling across [60, 40, 80] is 80 (minimum required protocol score)
      expect(selection!.effectiveRiskCeiling).toBe(80)
    })
  })
})
