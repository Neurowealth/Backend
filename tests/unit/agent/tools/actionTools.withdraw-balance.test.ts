/**
 * #767: the assistant withdraw tool must only count positions in the requested
 * asset (and protocol when given), summed with Decimal.
 */
jest.mock('../../../../src/db', () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn() },
    position: { findMany: jest.fn() },
  },
}))
jest.mock('../../../../src/controllers/transaction-controller', () => ({
  executeDeposit: jest.fn(),
  executeWithdraw: jest.fn(),
}))
jest.mock('../../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock('../../../../src/agent/router', () => ({
  executeRebalanceIfNeeded: jest.fn(),
  getThresholds: jest.fn(),
  compareProtocols: jest.fn(),
  logAgentAction: jest.fn(),
}))
jest.mock('../../../../src/agent/breakerService', () => ({ getBreakerStatusForUser: jest.fn() }))
jest.mock('../../../../src/agent/volatilityCircuitBreaker', () => ({ isPortfolioRebalanceAllowed: jest.fn() }))
jest.mock('../../../../src/strategy/service', () => ({
  loadActiveFollowsForUsers: jest.fn(),
  followStrategy: jest.fn(),
  unfollowStrategy: jest.fn(),
}))
jest.mock('../../../../src/agent/effectiveStrategy', () => ({
  resolveEffectiveConfig: jest.fn(),
  isKnownStrategyName: jest.fn(),
}))

import db from '../../../../src/db'
import { executeWithdraw } from '../../../../src/controllers/transaction-controller'
import { withdrawTool } from '../../../../src/agent/tools/actionTools'

const ctx = { userId: 'u1', actingAsUserId: null, dryRun: true } as any
const withdraw = () => withdrawTool

function positionsFor(all: any[]) {
  ;(db.position.findMany as jest.Mock).mockImplementation(async ({ where }: any) =>
    all.filter(
      (p) =>
        p.status === where.status &&
        p.assetSymbol === where.assetSymbol &&
        (!where.protocolName || p.protocolName === where.protocolName)
    )
  )
}

describe('#767 withdraw balance check', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(db.user.findUnique as jest.Mock).mockResolvedValue({ walletAddress: 'G123' })
  })

  it('rejects withdraw 500 USDC when the user only holds XLM', async () => {
    positionsFor([
      { status: 'ACTIVE', assetSymbol: 'XLM', protocolName: 'Blend', currentValue: '1000' },
    ])
    const res: any = await withdraw().execute({ amount: 500, assetSymbol: 'USDC' } as any, ctx)
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/Insufficient funds/)
    expect(executeWithdraw).not.toHaveBeenCalled()
  })

  it('filters by protocol when one is given', async () => {
    positionsFor([
      { status: 'ACTIVE', assetSymbol: 'USDC', protocolName: 'Blend', currentValue: '100' },
      { status: 'ACTIVE', assetSymbol: 'USDC', protocolName: 'Other', currentValue: '900' },
    ])
    const res: any = await withdraw().execute(
      { amount: 500, assetSymbol: 'USDC', protocolName: 'Blend' } as any,
      ctx
    )
    expect(res.ok).toBe(false)
  })

  it('previews availableBalance for the requested asset only', async () => {
    positionsFor([
      { status: 'ACTIVE', assetSymbol: 'USDC', protocolName: 'Blend', currentValue: '300.1' },
      { status: 'ACTIVE', assetSymbol: 'USDC', protocolName: 'Other', currentValue: '200.2' },
      { status: 'ACTIVE', assetSymbol: 'XLM', protocolName: 'Blend', currentValue: '1000' },
    ])
    const res: any = await withdraw().execute({ amount: 500, assetSymbol: 'USDC' } as any, ctx)
    expect(res.ok).toBe(true)
    expect(res.data.availableBalance).toBeCloseTo(500.3, 7)
  })

  it('sums exactly without float drift (0.1 + 0.2)', async () => {
    positionsFor([
      { status: 'ACTIVE', assetSymbol: 'USDC', protocolName: 'A', currentValue: '0.1' },
      { status: 'ACTIVE', assetSymbol: 'USDC', protocolName: 'B', currentValue: '0.2' },
    ])
    const res: any = await withdraw().execute({ amount: 0.3, assetSymbol: 'USDC' } as any, ctx)
    expect(res.ok).toBe(true)
  })
})
