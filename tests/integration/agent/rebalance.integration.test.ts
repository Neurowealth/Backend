/**
 * Integration test: rebalance job creates logs for each impacted user
 *
 * Validates that:
 * - A REBALANCE log row is written for EACH user who owns an affected position
 * - Each log row has the correct userId and positionId
 * - No log row is written against a random or "first" user
 * - System-level ANALYZE logs produced by the rebalance check have userId=null
 */

import { triggerRebalance, logAgentAction } from '../../../src/agent/router'

// ---- mock external dependencies ----------------------------------------

const mockSubmitRebalance = jest.fn()
jest.mock('../../../src/stellar/contract', () => ({
  triggerRebalance: (...args: unknown[]) => mockSubmitRebalance(...args),
}))

jest.mock('../../../src/agent/scanner', () => ({
  scanAllProtocols: jest.fn().mockResolvedValue([
    {
      name: 'protocol-b',
      apy: 8.5,
      assetSymbol: 'USDC',
      lastUpdated: new Date(),
      isAvailable: true,
    },
  ]),
  getCurrentOnChainApy: jest.fn().mockResolvedValue(5.0),
}))

jest.mock('../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

// In-memory log store to simulate db.agentLog.create
const agentLogStore: Array<{
  userId: string | null
  positionId: string | null
  action: string
  status: string
}> = []

const mockPositionFindFirst = jest.fn()
const mockPositionFindMany = jest.fn()
const mockTransactionCreate = jest.fn().mockResolvedValue({})
const mockAgentLogCreate = jest
  .fn()
  .mockImplementation(({ data }: { data: any }) => {
    agentLogStore.push({
      userId: data.userId ?? null,
      positionId: data.positionId ?? null,
      action: data.action,
      status: data.status,
    })
    return Promise.resolve({ id: `log-${agentLogStore.length}` })
  })

jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: {
    agentLog: {
      create: (...args: unknown[]) => mockAgentLogCreate(...args),
    },
    position: {
      findFirst: (...args: unknown[]) => mockPositionFindFirst(...args),
      findMany: (...args: unknown[]) => mockPositionFindMany(...args),
    },
    transaction: {
      create: (...args: unknown[]) => mockTransactionCreate(...args),
    },
    user: {
      // Should NOT be called by logAgentAction anymore
      findMany: jest
        .fn()
        .mockRejectedValue(
          new Error('db.user.findMany should not be called for agent logging')
        ),
    },
  },
}))

// ------------------------------------------------------------------------

describe('Rebalance integration: per-user agent log attribution', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    agentLogStore.length = 0

    mockSubmitRebalance.mockResolvedValue({ hash: 'tx-hash-001' })
  })

  describe('triggerRebalance with multiple impacted positions', () => {
    it('creates one REBALANCE log per (userId, positionId) pair', async () => {
      // Two users each owning one position
      const positions = [
        {
          id: 'pos-user1',
          userId: 'user-1',
          assetSymbol: 'USDC',
          user: { network: 'MAINNET' },
        },
        {
          id: 'pos-user2',
          userId: 'user-2',
          assetSymbol: 'USDC',
          user: { network: 'MAINNET' },
        },
      ]

      // findFirst is used to create the Transaction record (existing behaviour)
      mockPositionFindFirst.mockResolvedValue(positions[0])
      // findMany is used by logAgentAction to get all affected positions
      mockPositionFindMany.mockResolvedValue(positions)

      const positionIds = positions.map((p) => p.id)

      await triggerRebalance('protocol-a', 'protocol-b', '1000000', positionIds)

      const rebalanceLogs = agentLogStore.filter(
        (l) => l.action === 'REBALANCE'
      )
      expect(rebalanceLogs).toHaveLength(2)

      const loggedUserIds = rebalanceLogs.map((l) => l.userId)
      expect(loggedUserIds).toContain('user-1')
      expect(loggedUserIds).toContain('user-2')

      const loggedPositionIds = rebalanceLogs.map((l) => l.positionId)
      expect(loggedPositionIds).toContain('pos-user1')
      expect(loggedPositionIds).toContain('pos-user2')
    })

    it('does not write a log row against an arbitrary first user', async () => {
      const arbitraryFirstUserId = 'first-user-in-db'

      const positions = [
        {
          id: 'pos-alice',
          userId: 'user-alice',
          assetSymbol: 'USDC',
          user: { network: 'MAINNET' },
        },
      ]
      mockPositionFindFirst.mockResolvedValue(positions[0])
      mockPositionFindMany.mockResolvedValue(positions)

      await triggerRebalance(
        'protocol-a',
        'protocol-b',
        '500000',
        positions.map((p) => p.id)
      )

      const rebalanceLogs = agentLogStore.filter(
        (l) => l.action === 'REBALANCE'
      )
      const writtenUserIds = rebalanceLogs.map((l) => l.userId)

      expect(writtenUserIds).not.toContain(arbitraryFirstUserId)
      expect(writtenUserIds).toEqual(['user-alice'])
    })

    it('writes log with userId=null when no positionIds are provided (system-level)', async () => {
      // triggerRebalance called without position ids
      await triggerRebalance('protocol-a', 'protocol-b', '1000', [])

      const rebalanceLogs = agentLogStore.filter(
        (l) => l.action === 'REBALANCE'
      )
      expect(rebalanceLogs).toHaveLength(1)
      expect(rebalanceLogs[0].userId).toBeNull()
      expect(rebalanceLogs[0].positionId).toBeNull()
    })

    it('deduplicates logs when the same userId/positionId appears multiple times', async () => {
      // Same position repeated twice (edge case guard)
      const positions = [
        {
          id: 'pos-dup',
          userId: 'user-dup',
          assetSymbol: 'USDC',
          user: { network: 'MAINNET' },
        },
        {
          id: 'pos-dup',
          userId: 'user-dup',
          assetSymbol: 'USDC',
          user: { network: 'MAINNET' },
        },
      ]
      mockPositionFindFirst.mockResolvedValue(positions[0])
      mockPositionFindMany.mockResolvedValue(positions)

      await triggerRebalance('protocol-a', 'protocol-b', '250000', [
        'pos-dup',
        'pos-dup',
      ])

      const rebalanceLogs = agentLogStore.filter(
        (l) => l.action === 'REBALANCE'
      )
      expect(rebalanceLogs).toHaveLength(1)
    })
  })

  describe('logAgentAction standalone', () => {
    it('system scan (ANALYZE) log has userId=null', async () => {
      await logAgentAction('ANALYZE', 'SUCCESS', { positionsChecked: 10 })

      expect(agentLogStore).toHaveLength(1)
      expect(agentLogStore[0].userId).toBeNull()
      expect(agentLogStore[0].action).toBe('ANALYZE')
    })

    it('per-user log has correct userId and positionId', async () => {
      await logAgentAction('REBALANCE', 'SUCCESS', {}, 'user-xyz', 'pos-xyz')

      expect(agentLogStore).toHaveLength(1)
      expect(agentLogStore[0].userId).toBe('user-xyz')
      expect(agentLogStore[0].positionId).toBe('pos-xyz')
    })
  })
})
