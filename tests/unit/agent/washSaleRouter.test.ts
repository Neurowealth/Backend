/**
 * #788 - the agent must not fabricate wash-sale risk from the "likely rebuy"
 * heuristic alone. Drive executeRebalanceIfNeeded with a forced rebalance
 * decision and check the jurisdiction/loss evidence actually consulted.
 */
import { TaxJurisdiction } from '@prisma/client'
import { executeRebalanceIfNeeded } from '../../../src/agent/router'

const mockSubmitRebalance = jest.fn()
const mockScanAllProtocols = jest.fn()
const mockGetCurrentOnChainApy = jest.fn()
const mockAnalyze = jest.fn()
const mockUserFindFirst = jest.fn()
const mockCostBasisLotFindMany = jest.fn()
const mockTransactionCreate = jest.fn()
const mockPersistDecision = jest.fn().mockResolvedValue('decision-1')

jest.mock('../../../src/stellar/contract', () => ({
  triggerRebalance: (...args: unknown[]) => mockSubmitRebalance(...args),
}))

jest.mock('../../../src/agent/scanner', () => ({
  scanAllProtocols: (...args: unknown[]) => mockScanAllProtocols(...args),
  getCurrentOnChainApy: (...args: unknown[]) =>
    mockGetCurrentOnChainApy(...args),
}))

jest.mock('../../../src/agent/strategies', () => {
  class ForcedStrategy {
    async analyze(...args: unknown[]) {
      return mockAnalyze(...args)
    }
  }
  return {
    MaxYieldStrategy: ForcedStrategy,
    TargetAllocationStrategy: ForcedStrategy,
    GoalTrackingStrategy: ForcedStrategy,
  }
})

jest.mock('../../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}))

jest.mock('../../../src/agent/rebalanceDecision', () => ({
  persistRebalanceDecision: (...args: unknown[]) =>
    mockPersistDecision(...args),
}))

jest.mock('../../../src/db', () => {
  const client: any = {
    user: {
      findFirst: (...a: unknown[]) => mockUserFindFirst(...a),
      findUnique: jest.fn().mockResolvedValue({ liquidityFloor: '100' }),
    },
    costBasisLot: {
      findMany: (...a: unknown[]) => mockCostBasisLotFindMany(...a),
    },
    savingsGoal: { findFirst: jest.fn().mockResolvedValue(null) },
    protocolLiquiditySnapshot: { findMany: jest.fn().mockResolvedValue([]) },
    agentLog: { create: jest.fn().mockResolvedValue({ id: 'log-1' }) },
    transaction: {
      create: (...a: any[]) => mockTransactionCreate(...a),
    },
    position: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'pos-big',
        userId: 'user-1',
        positionId: 'pos-big',
        assetSymbol: 'USDC',
        user: { network: 'MAINNET' },
      }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    outboxOp: {
      create: jest.fn().mockResolvedValue({ id: 'op-1' }),
      findUnique: jest.fn().mockResolvedValue(null),
    },
  }
  client.$transaction = (fn: (tx: unknown) => unknown) => fn(client)
  return { __esModule: true, default: client }
})

jest.mock('../../../src/outbox/dispatcher', () => ({
  dispatchInBackground: jest.fn(),
}))

const POSITION = [
  { id: 'pos-big', amount: '10000000000000000000000', userId: 'user-1' },
]
const PREFERENCES = [
  {
    userId: 'user-1',
    strategyName: 'TARGET_ALLOCATION' as const,
    taxAwareRebalancing: true,
  },
]
// Net APY improvement is 5.5 (3.0 -> 8.5). The old code doubled this to 6
// and suppressed the move; the fix must let it through without evidence.
const THRESHOLDS = {
  minimumImprovement: 3,
  maxGasPercent: 0.1,
  maxSlippagePercent: 0.5,
}

async function runFor(jurisdiction: TaxJurisdiction) {
  mockUserFindFirst.mockResolvedValue({ taxJurisdiction: jurisdiction })
  return executeRebalanceIfNeeded(
    'Blend',
    POSITION,
    THRESHOLDS as any,
    PREFERENCES as any
  )
}

describe('agent wash-sale wiring (#788)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockScanAllProtocols.mockResolvedValue([
      {
        name: 'Luma',
        apy: 8.5,
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
    mockGetCurrentOnChainApy.mockResolvedValue(3.0)
    mockAnalyze.mockResolvedValue({
      shouldRebalance: true,
      targetProtocol: 'Luma',
      reasoning: 'forced for test',
    })
    mockSubmitRebalance.mockResolvedValue({ hash: 'tx-hash' })
    mockTransactionCreate.mockImplementation(({ data }: any) => ({
      id: 'txn-1',
      ...data,
    }))
    mockCostBasisLotFindMany.mockResolvedValue([])
  })

  it('does not flag a US user with no acquisition evidence', async () => {
    await runFor(TaxJurisdiction.US)

    expect(mockCostBasisLotFindMany).toHaveBeenCalledTimes(1)
    expect(mockTransactionCreate).toHaveBeenCalledTimes(1)
    expect(mockPersistDecision).not.toHaveBeenCalledWith(
      expect.objectContaining({
        rationale: expect.stringContaining('Wash-sale risk'),
      })
    )
  })

  it('skips the lot query entirely for a DE user', async () => {
    await runFor(TaxJurisdiction.DE)

    expect(mockCostBasisLotFindMany).not.toHaveBeenCalled()
    expect(mockTransactionCreate).toHaveBeenCalledTimes(1)
  })

  it('still suppresses a US loss with a real in-window acquisition', async () => {
    mockCostBasisLotFindMany.mockResolvedValue([
      {
        acquiredAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
        acquisitionPrice: '1.05',
      },
    ])

    await runFor(TaxJurisdiction.US)

    expect(mockTransactionCreate).not.toHaveBeenCalled()
    expect(mockPersistDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'HELD',
        rationale: expect.stringContaining('Wash-sale risk'),
      })
    )
  })
})
