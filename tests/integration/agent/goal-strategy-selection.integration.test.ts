/**
 * Integration test: goal-driven strategy selection (#281)
 *
 * Validates that:
 * - Users with NO active SavingsGoal see byte-for-byte identical strategy
 *   selection to before this feature existed (existing preference logic, e.g.
 *   MAX_YIELD, is untouched).
 * - Users WITH an active SavingsGoal have GoalTrackingStrategy selected
 *   instead of their stored preference, and the agent rebalances to chase the
 *   rate the goal actually needs even when the stored preference (e.g.
 *   TARGET_ALLOCATION with no better configured target) would not have.
 */

import { executeRebalanceIfNeeded } from '../../../src/agent/router'

const mockSubmitRebalance = jest.fn()
jest.mock('../../../src/stellar/contract', () => ({
  triggerRebalance: (...args: unknown[]) => mockSubmitRebalance(...args),
}))

const mockScanAllProtocols = jest.fn()
const mockGetCurrentOnChainApy = jest.fn()
jest.mock('../../../src/agent/scanner', () => ({
  scanAllProtocols: (...args: unknown[]) => mockScanAllProtocols(...args),
  getCurrentOnChainApy: (...args: unknown[]) =>
    mockGetCurrentOnChainApy(...args),
}))

jest.mock('../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

const mockSavingsGoalFindFirst = jest.fn()
const mockProtocolRiskScoreFindMany = jest.fn().mockResolvedValue([])
const mockPositionFindFirst = jest.fn().mockResolvedValue(null)
const mockPositionFindMany = jest.fn().mockResolvedValue([])
const mockTransactionCreate = jest.fn().mockResolvedValue({})
const mockAgentLogCreate = jest.fn().mockResolvedValue({ id: 'log-1' })

jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: {
    savingsGoal: {
      findFirst: (...args: unknown[]) => mockSavingsGoalFindFirst(...args),
    },
    protocolRiskScore: {
      findMany: (...args: unknown[]) => mockProtocolRiskScoreFindMany(...args),
    },
    position: {
      findFirst: (...args: unknown[]) => mockPositionFindFirst(...args),
      findMany: (...args: unknown[]) => mockPositionFindMany(...args),
    },
    transaction: {
      create: (...args: unknown[]) => mockTransactionCreate(...args),
    },
    agentLog: {
      create: (...args: unknown[]) => mockAgentLogCreate(...args),
    },
  },
}))

describe('Goal-driven strategy selection integration', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockPositionFindFirst.mockResolvedValue(null)
    mockPositionFindMany.mockResolvedValue([])
    mockTransactionCreate.mockResolvedValue({})
    mockAgentLogCreate.mockResolvedValue({ id: 'log-1' })
    mockSubmitRebalance.mockResolvedValue({ hash: 'tx-hash-goal' })
  })

  it('non-goal user: MAX_YIELD preference behaves exactly as before (no active goal query short-circuits it)', async () => {
    mockSavingsGoalFindFirst.mockResolvedValue(null)
    mockGetCurrentOnChainApy.mockResolvedValue(3.0)
    mockScanAllProtocols.mockResolvedValue([
      {
        name: 'Luma',
        apy: 8.0,
        assetSymbol: 'USDC',
        lastUpdated: new Date(),
        isAvailable: true,
      },
      {
        name: 'Blend',
        apy: 3.0,
        assetSymbol: 'USDC',
        lastUpdated: new Date(),
        isAvailable: true,
      },
    ])

    const result = await executeRebalanceIfNeeded(
      'Blend',
      [
        {
          id: 'pos-1',
          amount: '10000000000000000000000',
          userId: 'user-no-goal',
        },
      ],
      undefined,
      [{ userId: 'user-no-goal', strategyName: 'MAX_YIELD' }]
    )

    expect(mockSavingsGoalFindFirst).toHaveBeenCalledWith({
      where: { userId: 'user-no-goal', status: 'ACTIVE' },
    })
    expect(result).not.toBeNull()
    expect(result?.toProtocol).toBe('Luma')
  })

  it('goal user: GoalTrackingStrategy overrides a TARGET_ALLOCATION preference that would not otherwise rebalance', async () => {
    mockSavingsGoalFindFirst.mockResolvedValue({
      id: 'goal-1',
      userId: 'user-with-goal',
      targetAmount: '13000',
      startingAmount: '10000',
      targetDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      riskCeiling: null,
    })
    mockGetCurrentOnChainApy.mockResolvedValue(3.0)
    mockScanAllProtocols.mockResolvedValue([
      {
        name: 'Luma',
        apy: 35.0,
        assetSymbol: 'USDC',
        lastUpdated: new Date(),
        isAvailable: true,
      },
      {
        name: 'Blend',
        apy: 3.0,
        assetSymbol: 'USDC',
        lastUpdated: new Date(),
        isAvailable: true,
      },
    ])

    const result = await executeRebalanceIfNeeded(
      'Blend',
      [
        {
          id: 'pos-2',
          amount: '10000000000000000000000',
          userId: 'user-with-goal',
        },
      ],
      undefined,
      // TARGET_ALLOCATION with no targetAllocations configured would normally
      // decline to rebalance (see TargetAllocationStrategy's "no target
      // allocations configured" branch) — the active goal must override this.
      [{ userId: 'user-with-goal', strategyName: 'TARGET_ALLOCATION' }]
    )

    expect(mockSavingsGoalFindFirst).toHaveBeenCalledWith({
      where: { userId: 'user-with-goal', status: 'ACTIVE' },
    })
    expect(result).not.toBeNull()
    expect(result?.toProtocol).toBe('Luma')
  })
})
