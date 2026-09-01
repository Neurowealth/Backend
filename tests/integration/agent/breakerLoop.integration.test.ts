/**
 * Integration test (#345): agent circuit breaker blocks rebalancing.
 *
 *  - rebalanceCheckJob with a GLOBAL OPEN breaker writes a BLOCKED decision
 *    and never touches the money path (Stellar contract submit).
 *  - compareProtocols excludes an OPEN-breaker protocol as a target even when
 *    it is the highest-APY protocol (never move INTO a broken protocol).
 */
import { rebalanceCheckJob } from '../../../src/agent/loop'
import { compareProtocols } from '../../../src/agent/router'

const mockTriggerRebalance = jest.fn()
jest.mock('../../../src/stellar/contract', () => ({
  triggerRebalance: (...args: unknown[]) => mockTriggerRebalance(...args),
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
  logBackgroundJob: jest.fn(),
}))

jest.mock('../../../src/utils/correlation', () => {
  const actual = jest.requireActual('../../../src/utils/correlation')
  return { ...actual }
})

jest.mock('../../../src/strategy/service', () => ({
  loadActiveFollowsForUsers: jest.fn().mockResolvedValue(new Map()),
}))

jest.mock('../../../src/events/publisher', () => ({
  publishUserEvent: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('../../../src/services/alerting', () => ({
  alertingService: { emit: jest.fn().mockResolvedValue(undefined) },
}))

jest.mock('../../../src/outbox/dispatcher', () => ({
  dispatchInBackground: jest.fn(),
}))

jest.mock('../../../src/outbox/service', () => ({
  enqueueOutboxOp: jest.fn().mockResolvedValue('op-1'),
  deriveIdempotencyKey: jest.fn().mockReturnValue('idem-1'),
}))

const mockPositionFindMany = jest.fn()

const decisionRows: Array<any> = []
const mockRebalanceDecisionCreate = jest
  .fn()
  .mockImplementation(({ data }: any) => {
    decisionRows.push(data)
    return Promise.resolve({ id: `decision-${decisionRows.length}` })
  })
const mockRebalanceDecisionUpdate = jest.fn().mockResolvedValue({ id: 'd' })
const mockRebalanceDecisionFindFirst = jest.fn().mockResolvedValue(null)
const mockRebalanceDecisionFindUnique = jest.fn().mockResolvedValue(null)
const mockRebalanceDecisionGroupBy = jest.fn().mockResolvedValue([])

const mockAgentBreakerFindMany = jest.fn()
const mockAgentBreakerUpdate = jest
  .fn()
  .mockImplementation(({ data }: any) =>
    Promise.resolve({ id: 'bk-g', ...data })
  )
const mockAgentBreakerCreate = jest
  .fn()
  .mockImplementation(({ data }: any) =>
    Promise.resolve({ id: 'bk-new', ...data })
  )
const mockAgentBreakerUpsert = jest
  .fn()
  .mockImplementation(() => Promise.resolve({ id: 'bk-g' }))

const agentLogRows: Array<any> = []
const mockAgentLogCreate = jest.fn().mockImplementation(({ data }: any) => {
  agentLogRows.push(data)
  return Promise.resolve({ id: `log-${agentLogRows.length}` })
})

jest.mock('../../../src/db', () => {
  const client: any = {
    position: {
      findMany: (...args: unknown[]) => mockPositionFindMany(...args),
    },
    yieldSnapshot: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    rebalanceDecision: {
      create: (...args: unknown[]) => mockRebalanceDecisionCreate(...args),
      update: (...args: unknown[]) => mockRebalanceDecisionUpdate(...args),
      findFirst: (...args: unknown[]) =>
        mockRebalanceDecisionFindFirst(...args),
      findUnique: (...args: unknown[]) =>
        mockRebalanceDecisionFindUnique(...args),
      groupBy: (...args: unknown[]) => mockRebalanceDecisionGroupBy(...args),
    },
    protocolRate: {
      findFirst: jest.fn().mockResolvedValue({ fetchedAt: new Date() }),
    },
    agentCircuitBreaker: {
      findMany: (...args: unknown[]) => mockAgentBreakerFindMany(...args),
      update: (...args: unknown[]) => mockAgentBreakerUpdate(...args),
      create: (...args: unknown[]) => mockAgentBreakerCreate(...args),
      upsert: (...args: unknown[]) => mockAgentBreakerUpsert(...args),
    },
    agentLog: {
      create: (...args: unknown[]) => mockAgentLogCreate(...args),
    },
    auditPayloadHash: {
      create: jest.fn().mockResolvedValue({ id: 'hash-1' }),
    },
    user: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  }
  client.$transaction = (fn: (tx: unknown) => unknown) => fn(client)
  return { __esModule: true, default: client }
})

const PROTOCOLS = [
  {
    name: 'protocol-b',
    apy: 9.9,
    assetSymbol: 'USDC',
    lastUpdated: new Date(),
    isAvailable: true,
  },
  {
    name: 'protocol-c',
    apy: 8.0,
    assetSymbol: 'USDC',
    lastUpdated: new Date(),
    isAvailable: true,
  },
]

describe('Agent circuit breaker (#345)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    decisionRows.length = 0
    agentLogRows.length = 0

    mockScanAllProtocols.mockResolvedValue(PROTOCOLS.map((p) => ({ ...p })))
    mockGetCurrentOnChainApy.mockResolvedValue(5.0)
    mockTriggerRebalance.mockResolvedValue({ hash: 'tx-hash-001' })

    const now = new Date()
    mockAgentBreakerFindMany.mockResolvedValue([
      {
        id: 'bk-global',
        scope: 'GLOBAL',
        scopeKey: '',
        state: 'OPEN',
        trippedRule: 'stale_data',
        detail: { rule: 'stale_data', at: now.toISOString() },
        trippedAt: new Date(now.getTime() - 10 * 60 * 1000),
        autoResetAt: new Date(now.getTime() + 50 * 60 * 1000),
        resetBy: null,
        resetAt: null,
        updatedAt: now,
      },
    ])

    mockPositionFindMany.mockResolvedValue([
      {
        id: 'pos-1',
        userId: 'user-1',
        protocolName: 'protocol-a',
        status: 'ACTIVE',
        amount: '1000',
        user: { id: 'user-1', rebalanceStrategy: null, strategyConfig: null },
      },
      {
        id: 'pos-2',
        userId: 'user-2',
        protocolName: 'protocol-a',
        status: 'ACTIVE',
        amount: '2000',
        user: { id: 'user-2', rebalanceStrategy: null, strategyConfig: null },
      },
    ])
  })

  describe('rebalanceCheckJob with a GLOBAL OPEN breaker', () => {
    it('writes a BLOCKED decision and never submits a rebalance', async () => {
      await rebalanceCheckJob()

      // One batch (protocol-a:DEFAULT:none), one BLOCKED decision.
      expect(decisionRows).toHaveLength(1)
      expect(decisionRows[0]).toMatchObject({
        batchKey: 'protocol-a:DEFAULT:none',
        fromProtocol: 'protocol-a',
        outcome: 'BLOCKED',
        blockedReason: 'circuit_breaker_open',
        affectedPositions: 2,
      })
      expect(String(decisionRows[0].rationale)).toContain('GLOBAL')

      // Money path untouched.
      expect(mockTriggerRebalance).not.toHaveBeenCalled()
      expect(mockAgentBreakerCreate).not.toHaveBeenCalled()

      // The tick succeeded and reported zero rebalances.
      const analyze = agentLogRows.find(
        (l) => l.action === 'ANALYZE' && l.status === 'SUCCESS'
      )
      expect(analyze).toBeDefined()
      const analyzeInput = JSON.parse(analyze.inputData)
      expect(analyzeInput.rebalancesTriggered).toBe(0)
      expect(analyzeInput.breakers.globalOpen).toBe(true)
    })
  })

  describe('compareProtocols target exclusion', () => {
    it('never chooses an OPEN-breaker protocol as target', async () => {
      const comparison = await compareProtocols(
        'protocol-a',
        '1000',
        undefined,
        ['protocol-b']
      )
      expect(comparison).not.toBeNull()
      expect(comparison!.best.name).toBe('protocol-c')
      expect(comparison!.best.name).not.toBe('protocol-b')
      expect(mockScanAllProtocols).toHaveBeenCalled()
    })

    it('falls back to the blocked protocol when everything is excluded', async () => {
      mockScanAllProtocols.mockResolvedValue(
        PROTOCOLS.slice(0, 1).map((p) => ({ ...p }))
      )
      const comparison = await compareProtocols(
        'protocol-a',
        '1000',
        undefined,
        ['protocol-b']
      )
      expect(comparison).toBeNull()
    })
  })
})
