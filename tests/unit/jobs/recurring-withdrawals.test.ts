jest.mock('../../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  logBackgroundJob: jest.fn(),
}))

jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: {
    recurringWithdrawalPlan: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
      update: jest.fn(),
      findFirst: jest.fn(),
    },
    position: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
    },
    savingsGoal: {
      findFirst: jest.fn(),
    },
    outboxOp: {
      findMany: jest.fn(),
    },
    transaction: {
      findFirst: jest.fn(),
    },
  },
}))

jest.mock('../../../src/controllers/transaction-controller', () => ({
  executeWithdraw: jest.fn(),
}))

jest.mock('../../../src/outbox/service', () => ({
  isUserHalted: jest.fn(),
}))

jest.mock('../../../src/events/publisher', () => ({
  publishUserEvent: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('../../../src/utils/metrics', () => ({
  recordBackgroundJob: jest.fn(),
}))

jest.mock('../../../src/utils/job-metrics', () => ({
  recordJobSuccess: jest.fn(),
  recordJobFailure: jest.fn(),
}))

import db from '../../../src/db'
import { executeWithdraw } from '../../../src/controllers/transaction-controller'
import { isUserHalted } from '../../../src/outbox/service'
import { publishUserEvent } from '../../../src/events/publisher'
import {
  isExecutingClaimStale,
  claimDuePlan,
  executePlan,
  processRecurringWithdrawals,
  RECURRING_WITHDRAWAL_EXECUTING_LEASE_MS,
} from '../../../src/jobs/recurringWithdrawals'

declare const describe: any
declare const it: any
declare const expect: any
declare const beforeEach: any

const mockDb = db as any
const mockExecuteWithdraw = executeWithdraw as jest.Mock
const mockIsUserHalted = isUserHalted as jest.Mock
const mockPublish = publishUserEvent as jest.Mock

const testPlan = {
  id: 'plan-w-1',
  userId: 'user-w-1',
  destinationAddress:
    'GDESTINATION12345678901234567890123456789012345678901234',
  assetSymbol: 'USDC',
  amountMode: 'FIXED',
  amount: 100,
  amountValue: 100,
  minAmount: 20,
  cadence: 'WEEKLY',
  status: 'ACTIVE',
  nextRunAt: new Date(Date.now() - 1000),
  lastRunAt: null,
  lastRunStatus: null,
}

describe('recurringWithdrawals job', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockIsUserHalted.mockResolvedValue(false)
    mockDb.savingsGoal.findFirst.mockResolvedValue(null)
    mockDb.position.findMany.mockResolvedValue([
      {
        id: 'pos-1',
        userId: 'user-w-1',
        assetSymbol: 'USDC',
        currentValue: 500,
        yieldEarned: 25,
        status: 'ACTIVE',
      },
    ])
    mockDb.recurringWithdrawalPlan.findFirst.mockResolvedValue({
      id: 'prior-plan',
      lastRunStatus: 'executed',
    })
    mockDb.outboxOp.findMany.mockResolvedValue([])
    mockDb.transaction.findFirst.mockResolvedValue(null)
  })

  describe('isExecutingClaimStale', () => {
    it('returns true if lastRunAt is null', () => {
      const stale = isExecutingClaimStale(
        { ...testPlan, lastRunAt: null } as any,
        new Date()
      )
      expect(stale).toBe(true)
    })

    it('returns true if lastRunAt is older than lease window', () => {
      const past = new Date(
        Date.now() - RECURRING_WITHDRAWAL_EXECUTING_LEASE_MS - 1000
      )
      const stale = isExecutingClaimStale(
        { ...testPlan, lastRunAt: past } as any,
        new Date()
      )
      expect(stale).toBe(true)
    })

    it('returns false if lastRunAt is within lease window', () => {
      const recent = new Date(Date.now() - 1000)
      const stale = isExecutingClaimStale(
        { ...testPlan, lastRunAt: recent } as any,
        new Date()
      )
      expect(stale).toBe(false)
    })
  })

  describe('claimDuePlan', () => {
    it('returns null if plan is not active', async () => {
      mockDb.recurringWithdrawalPlan.findUnique.mockResolvedValue({
        ...testPlan,
        status: 'PAUSED',
      })
      const result = await claimDuePlan(testPlan.id)
      expect(result).toBeNull()
    })

    it('returns null if nextRunAt is in the future', async () => {
      mockDb.recurringWithdrawalPlan.findUnique.mockResolvedValue({
        ...testPlan,
        nextRunAt: new Date(Date.now() + 60000),
      })
      const result = await claimDuePlan(testPlan.id)
      expect(result).toBeNull()
    })

    it('claims plan atomically when due', async () => {
      mockDb.recurringWithdrawalPlan.findUnique.mockResolvedValue(testPlan)
      mockDb.recurringWithdrawalPlan.updateMany.mockResolvedValue({ count: 1 })

      const result = await claimDuePlan(testPlan.id)
      expect(result).toEqual(testPlan)
      expect(mockDb.recurringWithdrawalPlan.updateMany).toHaveBeenCalled()
    })
  })

  describe('executePlan compliance and guardrails', () => {
    it('pauses plan when user is halted by compliance freeze', async () => {
      mockIsUserHalted.mockResolvedValue(true)

      await executePlan(testPlan as any)

      expect(mockDb.recurringWithdrawalPlan.update).toHaveBeenCalledWith({
        where: { id: testPlan.id },
        data: {
          status: 'PAUSED',
          lastRunStatus: 'compliance_halted',
        },
      })
      expect(mockPublish).toHaveBeenCalledWith(
        testPlan.userId,
        'alerts',
        'recurring_withdrawal.held',
        expect.objectContaining({
          planId: testPlan.id,
        })
      )
      expect(mockExecuteWithdraw).not.toHaveBeenCalled()
    })

    it('holds execution when destination address is new and unverified', async () => {
      mockDb.recurringWithdrawalPlan.findFirst.mockResolvedValue(null)
      mockDb.outboxOp.findMany.mockResolvedValue([])

      await executePlan(testPlan as any)

      expect(mockDb.recurringWithdrawalPlan.update).toHaveBeenCalledWith({
        where: { id: testPlan.id },
        data: {
          lastRunStatus: 'held_new_destination',
        },
      })
      expect(mockPublish).toHaveBeenCalledWith(
        testPlan.userId,
        'alerts',
        'recurring_withdrawal.held',
        expect.objectContaining({
          reason: expect.stringContaining('New destination address'),
        })
      )
      expect(mockExecuteWithdraw).not.toHaveBeenCalled()
    })

    it('holds execution when active savings goal would be impaired (#359)', async () => {
      mockDb.savingsGoal.findFirst.mockResolvedValue({
        id: 'goal-1',
        userId: testPlan.userId,
        status: 'ACTIVE',
        targetAmount: 450,
      })

      await executePlan(testPlan as any)

      expect(mockDb.recurringWithdrawalPlan.update).toHaveBeenCalledWith({
        where: { id: testPlan.id },
        data: {
          lastRunStatus: 'held_goal_conflict',
        },
      })
      expect(mockPublish).toHaveBeenCalledWith(
        testPlan.userId,
        'alerts',
        'recurring_withdrawal.held',
        expect.objectContaining({
          reason: expect.stringContaining('savings goal'),
        })
      )
      expect(mockExecuteWithdraw).not.toHaveBeenCalled()
    })

    it('skips and rolls cadence forward when balance is insufficient', async () => {
      mockDb.position.findMany.mockResolvedValue([
        {
          id: 'pos-1',
          userId: 'user-w-1',
          assetSymbol: 'USDC',
          currentValue: 10,
          yieldEarned: 0,
          status: 'ACTIVE',
        },
      ])

      await executePlan(testPlan as any)

      expect(mockDb.recurringWithdrawalPlan.update).toHaveBeenCalledWith({
        where: { id: testPlan.id },
        data: {
          lastRunStatus: 'skipped_insufficient_funds',
          nextRunAt: expect.any(Date),
        },
      })
      expect(mockPublish).toHaveBeenCalledWith(
        testPlan.userId,
        'transactions',
        'recurring_withdrawal.skipped',
        expect.objectContaining({
          reason: expect.stringContaining('Insufficient balance'),
        })
      )
      expect(mockExecuteWithdraw).not.toHaveBeenCalled()
    })

    it('executes partial withdrawal down to minAmount when balance is lower than configured amount', async () => {
      mockDb.position.findMany.mockResolvedValue([
        {
          id: 'pos-1',
          userId: 'user-w-1',
          assetSymbol: 'USDC',
          currentValue: 50,
          yieldEarned: 0,
          status: 'ACTIVE',
        },
      ])
      mockExecuteWithdraw.mockResolvedValue({
        status: 'CONFIRMED',
        transaction: { txHash: '0xpartial123' },
      })

      await executePlan(testPlan as any)

      expect(mockExecuteWithdraw).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 50,
          walletAddress: testPlan.destinationAddress,
        })
      )
      expect(mockDb.recurringWithdrawalPlan.update).toHaveBeenCalledWith({
        where: { id: testPlan.id },
        data: {
          lastRunStatus: 'executed',
          nextRunAt: expect.any(Date),
        },
      })
    })

    it('marks pending_approval without advancing nextRunAt on high-value approval policy (#314)', async () => {
      mockExecuteWithdraw.mockResolvedValue({
        status: 'PENDING_APPROVAL',
        transaction: null,
        approvalRequestId: 'app-req-456',
      })

      await executePlan(testPlan as any)

      expect(mockDb.recurringWithdrawalPlan.update).toHaveBeenCalledWith({
        where: { id: testPlan.id },
        data: {
          lastRunStatus: 'pending_approval',
        },
      })
      expect(mockPublish).toHaveBeenCalledWith(
        testPlan.userId,
        'alerts',
        'recurring_withdrawal.held',
        expect.objectContaining({
          approvalRequestId: 'app-req-456',
        })
      )
      expect(mockPublish).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        'recurring_withdrawal.failed',
        expect.anything()
      )
    })

    it('successfully completes on-chain execution and publishes executed event', async () => {
      mockExecuteWithdraw.mockResolvedValue({
        status: 'CONFIRMED',
        transaction: { txHash: '0xconfirmedhash789' },
      })

      await executePlan(testPlan as any)

      expect(mockExecuteWithdraw).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: testPlan.userId,
          walletAddress: testPlan.destinationAddress,
          amount: 100,
          assetSymbol: 'USDC',
        })
      )
      expect(mockDb.recurringWithdrawalPlan.update).toHaveBeenCalledWith({
        where: { id: testPlan.id },
        data: {
          lastRunStatus: 'executed',
          nextRunAt: expect.any(Date),
        },
      })
      expect(mockPublish).toHaveBeenCalledWith(
        testPlan.userId,
        'transactions',
        'recurring_withdrawal.executed',
        expect.objectContaining({
          planId: testPlan.id,
          txHash: '0xconfirmedhash789',
          amount: 100,
        })
      )
    })
  })

  describe('amount mode calculations', () => {
    it('calculates PERCENT_OF_BALANCE mode accurately', async () => {
      const pctPlan = {
        ...testPlan,
        amountMode: 'PERCENT_OF_BALANCE',
        amount: 20,
        amountValue: 20,
      }
      mockExecuteWithdraw.mockResolvedValue({
        status: 'CONFIRMED',
        transaction: { txHash: '0xpcthash' },
      })

      await executePlan(pctPlan as any)

      expect(mockExecuteWithdraw).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 100,
        })
      )
    })

    it('calculates YIELD_ONLY mode accurately', async () => {
      const yieldPlan = {
        ...testPlan,
        amountMode: 'YIELD_ONLY',
        amount: null,
        amountValue: null,
      }
      mockExecuteWithdraw.mockResolvedValue({
        status: 'CONFIRMED',
        transaction: { txHash: '0xyieldhash' },
      })

      await executePlan(yieldPlan as any)

      expect(mockExecuteWithdraw).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 25,
        })
      )
    })
  })
})
