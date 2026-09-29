import {
  computeLiquidityFloorStatus,
  isPositionLocked,
  estimatePositionTimeToExit,
  isInstantLiquidPosition,
  calculateLiquidBalance,
  prioritizeShortfallExits,
  computeAvailableForYield,
  PositionLike,
} from '../../../src/agent/liquidityFloor'
import {
  stricterLiquidityFloor,
  resolveEffectiveConfig,
  parseStrategyConfig,
} from '../../../src/agent/effectiveStrategy'

describe('Liquidity Floor Pure Module (#541)', () => {
  describe('Locked and Collateral Position Exclusion', () => {
    it('identifies locked positions via isLocked, locked, or status', () => {
      expect(isPositionLocked({ protocolName: 'Aave', isLocked: true })).toBe(
        true
      )
      expect(isPositionLocked({ protocolName: 'Aave', locked: true })).toBe(
        true
      )
      expect(isPositionLocked({ protocolName: 'Aave', status: 'LOCKED' })).toBe(
        true
      )
      expect(isPositionLocked({ protocolName: 'Aave', status: 'locked' })).toBe(
        true
      )
    })

    it('identifies collateralized positions via isCollateral, collateral, or status', () => {
      expect(
        isPositionLocked({ protocolName: 'Compound', isCollateral: true })
      ).toBe(true)
      expect(
        isPositionLocked({ protocolName: 'Compound', collateral: true })
      ).toBe(true)
      expect(
        isPositionLocked({ protocolName: 'Compound', status: 'COLLATERAL' })
      ).toBe(true)
      expect(
        isPositionLocked({ protocolName: 'Compound', status: 'collateral' })
      ).toBe(true)
    })

    it('identifies locked positions via metadata lock flag', () => {
      expect(
        isPositionLocked({
          protocolName: 'Blend',
          metadata: { isLocked: true },
        })
      ).toBe(true)
    })

    it('identifies unlocked active positions as not locked', () => {
      expect(
        isPositionLocked({
          protocolName: 'Cash',
          status: 'ACTIVE',
          isLocked: false,
          isCollateral: false,
        })
      ).toBe(false)
    })

    it('locked positions return Infinity time to exit and never qualify as instant-liquid', () => {
      const lockedPos: PositionLike = {
        protocolName: 'Cash',
        currentValue: 1000,
        isLocked: true,
      }
      expect(estimatePositionTimeToExit(lockedPos)).toBe(Infinity)
      expect(isInstantLiquidPosition(lockedPos)).toBe(false)
    })
  })

  describe('Liquid Balance Calculation', () => {
    it('sums only active unlocked instant positions', () => {
      const positions: PositionLike[] = [
        { protocolName: 'Cash', currentValue: 500, status: 'ACTIVE' },
        {
          protocolName: 'Blend',
          currentValue: 300,
          isLocked: true,
          status: 'ACTIVE',
        },
        {
          protocolName: 'Aquarius',
          currentValue: 200,
          isCollateral: true,
          status: 'ACTIVE',
        },
        { protocolName: 'Wallet', currentValue: 250, status: 'ACTIVE' },
      ]
      const liquid = calculateLiquidBalance(positions)
      expect(liquid).toBe(750)
    })
  })

  describe('Precedence & Status Computation', () => {
    it('returns NO_FLOOR when floor is null, undefined, or zero', () => {
      const positions: PositionLike[] = [
        { protocolName: 'Cash', currentValue: 1000, status: 'ACTIVE' },
      ]
      const resNull = computeLiquidityFloorStatus({ floor: null, positions })
      expect(resNull.status).toBe('NO_FLOOR')
      expect(resNull.isSatisfied).toBe(true)
      expect(resNull.availableForYield).toBe('1000')

      const resZero = computeLiquidityFloorStatus({ floor: 0, positions })
      expect(resZero.status).toBe('NO_FLOOR')
      expect(resZero.availableForYield).toBe('1000')
    })

    it('satisfies floor when liquid balance exceeds floor', () => {
      const positions: PositionLike[] = [
        { protocolName: 'Cash', currentValue: 1500, status: 'ACTIVE' },
        { protocolName: 'YieldPool', currentValue: 500, status: 'ACTIVE' },
      ]
      const res = computeLiquidityFloorStatus({ floor: 1000, positions })
      expect(res.isSatisfied).toBe(true)
      expect(res.status).toBe('SATISFIED')
      expect(res.shortfall).toBe('0')
      expect(res.availableForYield).toBe('1000')
    })

    it('detects SHORTFALL when liquid balance is below floor but total balance exceeds floor', () => {
      const positions: PositionLike[] = [
        { protocolName: 'Cash', currentValue: 300, status: 'ACTIVE' },
        { protocolName: 'YieldProtocolA', currentValue: 400, status: 'ACTIVE' },
        { protocolName: 'YieldProtocolB', currentValue: 500, status: 'ACTIVE' },
      ]
      const res = computeLiquidityFloorStatus({ floor: 1000, positions })
      expect(res.isSatisfied).toBe(false)
      expect(res.status).toBe('SHORTFALL')
      expect(res.shortfall).toBe('700')
      expect(res.availableForYield).toBe('200')
      expect(res.unwindPlan).toBeDefined()
      expect(res.unwindPlan?.shortfall).toBe(700)
      expect(res.unwindPlan?.restoredAmount).toBe(700)
    })

    it('detects DEGRADED state when floor exceeds total balance', () => {
      const positions: PositionLike[] = [
        { protocolName: 'Cash', currentValue: 400, status: 'ACTIVE' },
        { protocolName: 'YieldProtocol', currentValue: 200, status: 'ACTIVE' },
      ]
      const res = computeLiquidityFloorStatus({ floor: 1000, positions })
      expect(res.isDegraded).toBe(true)
      expect(res.isSatisfied).toBe(false)
      expect(res.status).toBe('DEGRADED')
      expect(res.availableForYield).toBe('0')
      expect(res.statusMessage).toBe(
        'your floor exceeds your balance; nothing is currently earning yield'
      )
    })

    it('detects DEGRADED state when floor equals total balance', () => {
      const positions: PositionLike[] = [
        { protocolName: 'Cash', currentValue: 500, status: 'ACTIVE' },
        { protocolName: 'YieldProtocol', currentValue: 500, status: 'ACTIVE' },
      ]
      const res = computeLiquidityFloorStatus({ floor: 1000, positions })
      expect(res.isDegraded).toBe(true)
      expect(res.availableForYield).toBe('0')
      expect(res.statusMessage).toBe(
        'your floor exceeds your balance; nothing is currently earning yield'
      )
    })
  })

  describe('Shortfall Exit Prioritization', () => {
    it('prioritizes positions with the shortest time to exit', () => {
      const positions: PositionLike[] = [
        {
          id: 'pos-slow',
          protocolName: 'SlowLock',
          currentValue: 500,
          status: 'ACTIVE',
        },
        {
          id: 'pos-fast',
          protocolName: 'FastPool',
          currentValue: 500,
          status: 'ACTIVE',
        },
      ]

      const snapshots = {
        SlowLock: {
          protocolName: 'SlowLock',
          availableLiquidity: 1000,
          poolTvl: 1000,
        },
        FastPool: {
          protocolName: 'FastPool',
          availableLiquidity: 100000,
          poolTvl: 100000,
        },
      }

      const plan = prioritizeShortfallExits(positions, 400, snapshots)

      expect(plan.exits.length).toBeGreaterThan(0)
      expect(plan.restoredAmount).toBe(400)
      expect(plan.remainingShortfall).toBe(0)
      expect(plan.exits[0].positionId).toBe('pos-fast')
    })
  })

  describe('computeAvailableForYield pure helper', () => {
    it('clamps available yield between 0 and totalBalance - floor', () => {
      expect(
        computeAvailableForYield({ totalBalance: 1000, liquidityFloor: 400 })
          .availableForYield
      ).toBe('600')
      expect(
        computeAvailableForYield({ totalBalance: 1000, liquidityFloor: 1000 })
          .availableForYield
      ).toBe('0')
      expect(
        computeAvailableForYield({ totalBalance: 1000, liquidityFloor: 1500 })
          .availableForYield
      ).toBe('0')
      expect(
        computeAvailableForYield({ totalBalance: 1000, liquidityFloor: null })
          .availableForYield
      ).toBe('1000')
      expect(
        computeAvailableForYield({
          totalBalance: 1000,
          liquidityFloor: undefined,
        }).availableForYield
      ).toBe('1000')
    })
  })

  describe('Follower Strategy Tightening (#541)', () => {
    it('stricterLiquidityFloor picks the highest floor value', () => {
      expect(stricterLiquidityFloor(500, 1000)).toBe('1000')
      expect(stricterLiquidityFloor(1000, 500)).toBe('1000')
      expect(stricterLiquidityFloor(null, 500)).toBe('500')
      expect(stricterLiquidityFloor(500, null)).toBe('500')
      expect(stricterLiquidityFloor(null, null)).toBeUndefined()
    })

    it('resolveEffectiveConfig enforces follower floor tightening', () => {
      const own = {
        strategyName: 'MAX_YIELD' as const,
        liquidityFloor: '800',
      }
      const followed = {
        strategyName: 'MAX_YIELD' as const,
        liquidityFloor: '500',
      }

      const effective = resolveEffectiveConfig(own, followed)
      expect(effective.liquidityFloor).toBe('800')
    })

    it('parseStrategyConfig correctly parses liquidityFloor', () => {
      const parsed = parseStrategyConfig({
        strategyName: 'MAX_YIELD',
        liquidityFloor: 250,
      })
      expect(parsed?.liquidityFloor).toBe('250')
    })
  })
})
