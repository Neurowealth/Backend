import db from '../../../src/db'
import { computeGoalProgress, createGoal } from '../../../src/goals/service'
import { scanAllProtocols } from '../../../src/agent/scanner'

jest.mock('../../../src/db', () => ({ __esModule: true, default: {} }))
jest.mock('../../../src/agent/router', () => ({ logAgentAction: jest.fn() }))
jest.mock('../../../src/agent/scanner', () => ({ scanAllProtocols: jest.fn() }))

const mockDb = db as any
const mockScanAllProtocols = scanAllProtocols as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  process.env.USDC_ISSUER = 'GUSDC_ISSUER'
  mockScanAllProtocols.mockResolvedValue([])
  mockDb.savingsGoal = {
    findFirst: jest.fn().mockResolvedValue(null),
    findUnique: jest.fn(),
    create: jest.fn(async ({ data }: any) => ({ id: 'goal-1', ...data })),
    update: jest.fn(),
  }
  mockDb.position = {
    findMany: jest.fn().mockResolvedValue([{ currentValue: 40 }]),
  }
  mockDb.yieldSnapshot = { findMany: jest.fn().mockResolvedValue([]) }
  mockDb.linkedExternalWallet = {
    findMany: jest.fn().mockResolvedValue([
      {
        balances: [
          {
            assetType: 'credit_alphanum4',
            assetCode: 'USDC',
            assetIssuer: 'GUSDC_ISSUER',
            amount: '10.25',
          },
          {
            assetType: 'native',
            assetCode: 'XLM',
            assetIssuer: null,
            amount: '500',
          },
          {
            assetType: 'credit_alphanum4',
            assetCode: 'USDC',
            assetIssuer: 'GATTACKER',
            amount: '900',
          },
        ],
      },
    ]),
  }
})

describe('goal external holdings opt-in', () => {
  it('keeps existing goal semantics platform-only by default', async () => {
    const goal = await createGoal('user-1', {
      targetAmount: 100,
      targetDate: new Date(Date.now() + 86_400_000),
    })

    expect(goal.startingAmount).toBe(40)
    expect(goal.includeExternalHoldings).toBe(false)
    expect(mockDb.linkedExternalWallet.findMany).not.toHaveBeenCalled()
  })

  it('keeps agent-visible starting amount platform-only for opted-in goals', async () => {
    const goal = await createGoal('user-1', {
      targetAmount: 100,
      targetDate: new Date(Date.now() + 86_400_000),
      includeExternalHoldings: true,
    })

    expect(goal.startingAmount).toBe(40)
    expect(goal.includeExternalHoldings).toBe(true)
    expect(mockDb.linkedExternalWallet.findMany).not.toHaveBeenCalled()
  })

  it('adds external known USD value to live progress only when the goal opted in', async () => {
    mockDb.savingsGoal.findUnique.mockResolvedValue({
      id: 'goal-1',
      userId: 'user-1',
      positionId: null,
      targetAmount: 10000,
      startingAmount: 40,
      targetDate: new Date(Date.now() + 365 * 86_400_000),
      riskCeiling: null,
      includeExternalHoldings: true,
      status: 'ACTIVE',
    })

    const progress = await computeGoalProgress('goal-1')

    expect(progress.currentAmount).toBe(50.25)
    expect(progress.includeExternalHoldings).toBe(true)
    expect(progress.requiredApy).toBeGreaterThan(0)
    expect(progress.note).toContain('unverified external snapshots')
    expect(progress.externalStaleWalletCount).toBe(1)
    expect(progress.unpricedExternalHoldingCount).toBe(2)
  })
})
