const mockDb = {
  user: { findUnique: jest.fn() },
  position: { findMany: jest.fn() },
  protocolLiquiditySnapshot: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
  },
}

jest.mock('../../../src/db', () => ({ __esModule: true, default: mockDb }))

import db from '../../../src/db'
import { getLiquidityFloorStatus } from '../../../src/analytics/liquidityFloor'
import {
  buildExplicitProtocolLiquiditySnapshot,
  buildStellarDexLiquiditySnapshot,
  recordLiquiditySnapshot,
} from '../../../src/analytics/liquiditySnapshot'

const mockedDb = db as any
const NOW = new Date('2026-09-30T12:00:00.000Z')

function resetDb() {
  jest.resetAllMocks()
  mockedDb.user.findUnique.mockResolvedValue({ liquidityFloor: '50' })
  mockedDb.position.findMany.mockResolvedValue([
    {
      id: 'position-1',
      protocolName: 'Stellar DEX',
      assetSymbol: 'USDC',
      currentValue: '1000000000',
      liquidityLocked: false,
    },
  ])
  mockedDb.protocolLiquiditySnapshot.findMany.mockResolvedValue([
    {
      protocolName: 'Stellar DEX',
      assetSymbol: 'USDC',
      availableLiquidity: '1000',
      withdrawalQueueDepth: 0,
      withdrawalDelayHours: 0,
      depthCurve: [{ sizeUsd: 1000, priceImpactBps: 0 }],
      fetchedAt: NOW,
    },
  ])
  mockedDb.protocolLiquiditySnapshot.findFirst.mockResolvedValue(null)
}

describe('buildStellarDexLiquiditySnapshot', () => {
  it('aggregates matching USDC reserves as immediately withdrawable liquidity', () => {
    expect(
      buildStellarDexLiquiditySnapshot(
        [
          {
            reserves: [
              { asset: 'USDC:ISSUER', amount: '120' },
              { asset: 'XLM:native', amount: '40' },
            ],
          },
          { reserves: [{ asset: 'USDC:ISSUER', amount: '30' }] },
        ],
        'USDC:ISSUER'
      )
    ).toEqual({
      protocolName: 'Stellar DEX',
      assetSymbol: 'USDC',
      poolTvl: 150,
      availableLiquidity: 150,
      dailyVolume: 0,
      withdrawalQueueDepth: 0,
      withdrawalDelayHours: 0,
      depthCurve: [
        {
          sizeUsd: (150 * 50) / 9950,
          priceImpactBps: 50,
        },
      ],
    })
  })

  it('does not classify missing or invalid reserve data as liquid', () => {
    expect(
      buildStellarDexLiquiditySnapshot(
        [{ reserves: [{ asset: 'USDC:ISSUER', amount: 'NaN' }] }],
        'USDC:ISSUER'
      )
    ).toBeNull()
  })
})

describe('buildExplicitProtocolLiquiditySnapshot', () => {
  it('accepts provider data only when delay, queue, and depth are explicit', () => {
    expect(
      buildExplicitProtocolLiquiditySnapshot('Blend', 'USDC', {
        availableLiquidity: 1000,
        withdrawalQueueDepth: 0,
        withdrawalDelayHours: 0,
        depthCurve: [{ sizeUsd: 100, priceImpactBps: 50 }],
      })
    ).toMatchObject({
      protocolName: 'Blend',
      assetSymbol: 'USDC',
      availableLiquidity: 1000,
      withdrawalQueueDepth: 0,
      withdrawalDelayHours: 0,
    })
  })

  it('rejects provider data that omits withdrawal delay', () => {
    expect(
      buildExplicitProtocolLiquiditySnapshot('Luma', 'USDC', {
        availableLiquidity: 1000,
        withdrawalQueueDepth: 0,
        depthCurve: [{ sizeUsd: 100, priceImpactBps: 50 }],
      })
    ).toBeNull()
  })

  it('does not coerce a null withdrawal delay to zero', () => {
    expect(
      buildExplicitProtocolLiquiditySnapshot('Blend', 'USDC', {
        availableLiquidity: 1000,
        withdrawalQueueDepth: 0,
        withdrawalDelayHours: null,
        depthCurve: [{ sizeUsd: 100, priceImpactBps: 50 }],
      })
    ).toBeNull()
  })
})

describe('liquidity snapshot persistence', () => {
  beforeEach(resetDb)

  it('avoids inserting another fresh snapshot for the same protocol and asset', async () => {
    mockedDb.protocolLiquiditySnapshot.findFirst.mockResolvedValue({
      id: 'existing',
    })
    await recordLiquiditySnapshot(
      {
        protocolName: 'Stellar DEX',
        assetSymbol: 'USDC',
        poolTvl: 100,
        availableLiquidity: 100,
        dailyVolume: 0,
        withdrawalQueueDepth: 0,
        withdrawalDelayHours: 0,
        depthCurve: [{ sizeUsd: 100, priceImpactBps: 0 }],
      },
      NOW
    )
    expect(mockedDb.protocolLiquiditySnapshot.create).not.toHaveBeenCalled()
  })
})

describe('getLiquidityFloorStatus', () => {
  beforeEach(resetDb)

  it('counts only a fresh, fully exitable, unlocked USDC position', async () => {
    const status = await getLiquidityFloorStatus('user-1', NOW)
    expect(status).toMatchObject({
      floorUsd: 50,
      totalBalanceUsd: 100,
      liquidBalanceUsd: 100,
      availableForYieldUsd: 50,
      shortfallUsd: 0,
      dataAvailable: true,
      instantLiquidPositionIds: ['position-1'],
    })
  })

  it('excludes locked positions and reports their floor shortfall', async () => {
    mockedDb.position.findMany.mockResolvedValue([
      {
        id: 'position-1',
        protocolName: 'Stellar DEX',
        assetSymbol: 'USDC',
        currentValue: '1000000000',
        liquidityLocked: true,
      },
    ])
    const status = await getLiquidityFloorStatus('user-1', NOW)
    expect(status).toMatchObject({
      liquidBalanceUsd: 0,
      shortfallUsd: 50,
      estimatedRestoreHours: null,
      dataAvailable: true,
      instantLiquidPositionIds: [],
    })
  })

  it('fails closed when a fresh snapshot is missing', async () => {
    mockedDb.protocolLiquiditySnapshot.findMany.mockResolvedValue([])
    const status = await getLiquidityFloorStatus('user-1', NOW)
    expect(status).toMatchObject({
      liquidBalanceUsd: 0,
      shortfallUsd: 50,
      dataAvailable: false,
      availableForYieldUsd: 0,
      instantProtocolNames: [],
    })
  })

  it('does not report a complete restoration time when known exits cannot cover the shortfall', async () => {
    mockedDb.user.findUnique.mockResolvedValue({ liquidityFloor: '500' })
    mockedDb.position.findMany.mockResolvedValue([
      {
        id: 'position-1',
        protocolName: 'Stellar DEX',
        assetSymbol: 'USDC',
        currentValue: '1000000000',
        liquidityLocked: false,
        transactions: [],
      },
    ])
    mockedDb.protocolLiquiditySnapshot.findMany.mockResolvedValue([
      {
        protocolName: 'Stellar DEX',
        assetSymbol: 'USDC',
        availableLiquidity: '100',
        withdrawalQueueDepth: 0,
        withdrawalDelayHours: 0,
        depthCurve: [{ sizeUsd: 1, priceImpactBps: 50 }],
        fetchedAt: NOW,
      },
    ])
    const status = await getLiquidityFloorStatus('user-1', NOW)
    expect(status.estimatedRestoreHours).toBeNull()
  })

  it('fails closed while a position transaction is pending', async () => {
    mockedDb.position.findMany.mockResolvedValue([
      {
        id: 'position-1',
        protocolName: 'Stellar DEX',
        assetSymbol: 'USDC',
        currentValue: '1000000000',
        liquidityLocked: false,
        transactions: [{ id: 'pending-withdrawal' }],
      },
    ])
    const status = await getLiquidityFloorStatus('user-1', NOW)
    expect(status).toMatchObject({
      liquidBalanceUsd: 0,
      dataAvailable: false,
    })
  })
})
