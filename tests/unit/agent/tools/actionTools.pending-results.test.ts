import {
  depositTool,
  withdrawTool,
  __resetSensitiveOpsVelocityForTests,
} from '../../../../src/agent/tools/actionTools'
import db from '../../../../src/db'
import {
  executeDeposit,
  executeWithdraw,
} from '../../../../src/controllers/transaction-controller'

jest.mock('../../../../src/db', () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn() },
    position: { findMany: jest.fn() },
    recurringDepositPlan: { create: jest.fn() },
    alertRule: { create: jest.fn() },
    publishedStrategy: { findFirst: jest.fn() },
  },
}))

jest.mock('../../../../src/controllers/transaction-controller', () => ({
  executeDeposit: jest.fn(),
  executeWithdraw: jest.fn(),
}))

jest.mock('../../../../src/agent/router', () => ({
  executeRebalanceIfNeeded: jest.fn(),
  getThresholds: jest.fn(() => ({
    minimumImprovement: 0.5,
    maxGasPercent: 0.1,
  })),
  compareProtocols: jest.fn(),
  logAgentAction: jest.fn(),
}))

jest.mock('../../../../src/agent/breakerService', () => ({
  getBreakerStatusForUser: jest.fn(),
}))

jest.mock('../../../../src/agent/volatilityCircuitBreaker', () => ({
  isPortfolioRebalanceAllowed: jest.fn(),
}))

jest.mock('../../../../src/strategy/service', () => ({
  loadActiveFollowsForUsers: jest.fn(() => new Map()),
  followStrategy: jest.fn(),
  unfollowStrategy: jest.fn(),
}))

jest.mock('../../../../src/agent/effectiveStrategy', () => ({
  resolveEffectiveConfig: jest.fn((own) => own),
  isKnownStrategyName: jest.fn(() => true),
}))

jest.mock('../../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

const ctx = {
  userId: 'user-abc',
  actingAsUserId: null,
  channel: 'api' as const,
  dryRun: false,
}

beforeEach(() => {
  jest.clearAllMocks()
  __resetSensitiveOpsVelocityForTests()
  jest.mocked(db.user.findUnique).mockResolvedValue({
    walletAddress: 'GFAKE12345',
  } as any)
  jest
    .mocked(db.position.findMany)
    .mockResolvedValue([{ currentValue: '1000' }] as any)
})

function expectPendingSuccess(
  result: any,
  status: 'PENDING' | 'PENDING_APPROVAL',
  identifier: { txHash: string } | { approvalRequestId: string }
) {
  expect(result.ok).toBe(true)
  expect(result.data).toMatchObject({ status, ...identifier })
  expect(result.data.message).toEqual(expect.any(String))
  expect(JSON.stringify(result)).not.toMatch(/try again/i)
}

describe('assistant money-movement pending results (#764)', () => {
  it('reports a pending deposit as submitted without asking the user to retry', async () => {
    jest.mocked(executeDeposit).mockResolvedValue({
      status: 'PENDING',
      transaction: {
        txHash: 'deposit-hash',
        status: 'PENDING',
        amount: '25',
        assetSymbol: 'USDC',
      },
    } as any)

    const result = await depositTool.execute(
      { amount: 25, assetSymbol: 'USDC' },
      ctx
    )

    expectPendingSuccess(result, 'PENDING', { txHash: 'deposit-hash' })
  })

  it('reports a deposit approval request without asking the user to retry', async () => {
    jest.mocked(executeDeposit).mockResolvedValue({
      status: 'PENDING_APPROVAL',
      transaction: null,
      approvalRequestId: 'deposit-approval-1',
    } as any)

    const result = await depositTool.execute(
      { amount: 25, assetSymbol: 'USDC' },
      ctx
    )

    expectPendingSuccess(result, 'PENDING_APPROVAL', {
      approvalRequestId: 'deposit-approval-1',
    })
  })

  it('reports a pending withdrawal as submitted without asking the user to retry', async () => {
    jest.mocked(executeWithdraw).mockResolvedValue({
      status: 'PENDING',
      transaction: {
        txHash: 'withdraw-hash',
        status: 'PENDING',
        amount: '25',
        assetSymbol: 'USDC',
      },
    } as any)

    const result = await withdrawTool.execute(
      { amount: 25, assetSymbol: 'USDC' },
      ctx
    )

    expectPendingSuccess(result, 'PENDING', { txHash: 'withdraw-hash' })
  })

  it('reports a withdrawal approval request without asking the user to retry', async () => {
    jest.mocked(executeWithdraw).mockResolvedValue({
      status: 'PENDING_APPROVAL',
      transaction: null,
      approvalRequestId: 'withdraw-approval-1',
    } as any)

    const result = await withdrawTool.execute(
      { amount: 25, assetSymbol: 'USDC' },
      ctx
    )

    expectPendingSuccess(result, 'PENDING_APPROVAL', {
      approvalRequestId: 'withdraw-approval-1',
    })
  })
})
