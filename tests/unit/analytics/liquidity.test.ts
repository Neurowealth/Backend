import {
  calculateLiquidityFloor,
  planLiquidityFloorRestoration,
} from '../../../src/analytics/liquidity'

describe('calculateLiquidityFloor', () => {
  it('limits yield allocation to total balance minus the minimum floor', () => {
    expect(
      calculateLiquidityFloor({
        totalBalanceUsd: 1000,
        liquidBalanceUsd: 700,
        floorUsd: 500,
      })
    ).toEqual({ availableForYieldUsd: 500, shortfallUsd: 0 })
  })

  it('reports a shortfall and keeps all funds liquid when floor exceeds balance', () => {
    expect(
      calculateLiquidityFloor({
        totalBalanceUsd: 100,
        liquidBalanceUsd: 0,
        floorUsd: 500,
      })
    ).toEqual({ availableForYieldUsd: 0, shortfallUsd: 500 })
  })

  it('fails closed on invalid inputs', () => {
    expect(
      calculateLiquidityFloor({
        totalBalanceUsd: Number.NaN,
        liquidBalanceUsd: 0,
        floorUsd: 10,
      })
    ).toEqual({ availableForYieldUsd: 0, shortfallUsd: 0 })
  })
})

describe('planLiquidityFloorRestoration', () => {
  it('restores from the shortest exits first and skips locked or unknown positions', () => {
    expect(
      planLiquidityFloorRestoration(
        [
          {
            positionId: 'slow',
            valueUsd: 500,
            timeToExitHours: 12,
            locked: false,
          },
          {
            positionId: 'fast',
            valueUsd: 100,
            timeToExitHours: 1,
            locked: false,
          },
          {
            positionId: 'locked',
            valueUsd: 500,
            timeToExitHours: 0,
            locked: true,
          },
          {
            positionId: 'unknown',
            valueUsd: 500,
            timeToExitHours: null,
            locked: false,
          },
        ],
        250
      )
    ).toEqual([
      { positionId: 'fast', amountUsd: 100, timeToExitHours: 1 },
      { positionId: 'slow', amountUsd: 150, timeToExitHours: 12 },
    ])
  })

  it('does not create a restoration plan for an invalid or empty shortfall', () => {
    expect(planLiquidityFloorRestoration([], 0)).toEqual([])
    expect(planLiquidityFloorRestoration([], Number.NaN)).toEqual([])
  })
})
