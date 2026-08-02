/**
 * Unit tests for logAgentAction
 *
 * Validates that:
 * - No log row is written against a random/first user
 * - Rebalance logs include correct userId and positionId
 * - System-level scans produce logs with a null userId
 * - The function works correctly with multiple users
 */

// Must be declared before any imports so Jest hoists them above the module
// resolution chain and prevents env-var validation from firing.
jest.mock('../../../src/stellar/contract', () => ({
  triggerRebalance: jest.fn(),
}))
jest.mock('../../../src/config', () => ({
  config: {
    stellar: {
      network: 'TESTNET',
      rpcUrl: '',
      agentSecretKey: '',
      vaultContractId: '',
      usdcTokenAddress: '',
    },
    jwt: { seed: 'test-seed' },
    walletEncryption: { key: 'test-key' },
    twilio: {
      authToken: 'test-token',
      accountSid: '',
      phoneNumber: '',
      whatsappNumber: '',
    },
    anthropic: { apiKey: 'test-key' },
    database: { url: 'postgresql://test' },
  },
}))

import { logAgentAction } from '../../../src/agent/router'

// ---- mock the db module -----------------------------------------------
const mockAgentLogCreate = jest.fn().mockResolvedValue({ id: 'log-1' })
const mockAgentLogFindMany = jest.fn()
const mockUserFindMany = jest.fn()

jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: {
    agentLog: {
      create: (...args: unknown[]) => mockAgentLogCreate(...args),
      findMany: (...args: unknown[]) => mockAgentLogFindMany(...args),
    },
    user: {
      findMany: (...args: unknown[]) => mockUserFindMany(...args),
    },
  },
}))

// ---- mock logger so tests stay silent ---------------------------------
jest.mock('../../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}))

// -----------------------------------------------------------------------

describe('logAgentAction', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockAgentLogCreate.mockResolvedValue({ id: 'log-1' })
  })

  describe('system-level actions (no userId)', () => {
    it('writes a log row with userId=null when no userId is provided', async () => {
      await logAgentAction('ANALYZE', 'SUCCESS', { positionsChecked: 5 })

      expect(mockAgentLogCreate).toHaveBeenCalledTimes(1)
      const callArg = mockAgentLogCreate.mock.calls[0][0]
      expect(callArg.data.userId).toBeNull()
      expect(callArg.data.positionId).toBeNull()
    })

    it('does NOT call db.user.findMany (no first-user lookup)', async () => {
      await logAgentAction('ANALYZE', 'SUCCESS')

      expect(mockUserFindMany).not.toHaveBeenCalled()
    })

    it('stores action and status correctly', async () => {
      await logAgentAction('ANALYZE', 'FAILED', { error: 'timeout' })

      const callArg = mockAgentLogCreate.mock.calls[0][0]
      expect(callArg.data.action).toBe('ANALYZE')
      expect(callArg.data.status).toBe('FAILED')
      expect(callArg.data.errorMessage).toBe('timeout')
    })
  })

  describe('user-level actions (explicit userId)', () => {
    it('writes a log row with the supplied userId', async () => {
      await logAgentAction('REBALANCE', 'SUCCESS', {}, 'user-abc')

      const callArg = mockAgentLogCreate.mock.calls[0][0]
      expect(callArg.data.userId).toBe('user-abc')
    })

    it('writes a log row with the supplied positionId', async () => {
      await logAgentAction('REBALANCE', 'SUCCESS', {}, 'user-abc', 'pos-xyz')

      const callArg = mockAgentLogCreate.mock.calls[0][0]
      expect(callArg.data.positionId).toBe('pos-xyz')
    })

    it('does NOT call db.user.findMany when userId is explicitly provided', async () => {
      await logAgentAction('REBALANCE', 'SUCCESS', {}, 'user-1')

      expect(mockUserFindMany).not.toHaveBeenCalled()
    })
  })

  describe('multiple users', () => {
    it('creates separate log rows for each user without cross-contamination', async () => {
      const users = [
        { id: 'user-1', positionId: 'pos-1' },
        { id: 'user-2', positionId: 'pos-2' },
        { id: 'user-3', positionId: 'pos-3' },
      ]

      for (const u of users) {
        await logAgentAction('REBALANCE', 'SUCCESS', {}, u.id, u.positionId)
      }

      expect(mockAgentLogCreate).toHaveBeenCalledTimes(3)

      const calls = mockAgentLogCreate.mock.calls.map((c) => ({
        userId: c[0].data.userId,
        positionId: c[0].data.positionId,
      }))

      expect(calls).toEqual([
        { userId: 'user-1', positionId: 'pos-1' },
        { userId: 'user-2', positionId: 'pos-2' },
        { userId: 'user-3', positionId: 'pos-3' },
      ])
    })

    it('does not write any log with a random/first-user ID', async () => {
      const explicitUsers = ['user-alice', 'user-bob']
      for (const uid of explicitUsers) {
        await logAgentAction('REBALANCE', 'SUCCESS', {}, uid)
      }

      const writtenUserIds = mockAgentLogCreate.mock.calls.map(
        (c) => c[0].data.userId
      )
      expect(writtenUserIds).not.toContain('first-user-id')
      expect(writtenUserIds).toEqual(explicitUsers)
    })
  })

  describe('error handling', () => {
    it('does not throw if db.agentLog.create rejects', async () => {
      mockAgentLogCreate.mockRejectedValueOnce(new Error('DB connection lost'))

      await expect(
        logAgentAction('ANALYZE', 'FAILED', {}, 'user-1')
      ).resolves.toBeUndefined()
    })
  })
})
