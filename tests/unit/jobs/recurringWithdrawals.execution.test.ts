jest.mock('../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  logBackgroundJob: jest.fn(),
}))
jest.mock('../../../src/controllers/transaction-controller', () => ({
  executeWithdraw: jest.fn(),
}))
jest.mock('../../../src/services/withdrawal-controls.service', () => ({
  assessWithdrawal: jest.fn(),
}))
jest.mock('../../../src/events/publisher', () => ({
  publishUserEvent: jest.fn(async () => {}),
}))
jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: {
    recurringWithdrawalPlan: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
      update: jest.fn(),
    },
    position: { findMany: jest.fn() },
    transaction: { findFirst: jest.fn() },
    linkedExternalWallet: { findFirst: jest.fn() },
    complianceCase: { findFirst: jest.fn() },
    savingsGoal: { findMany: jest.fn() },
  },
}))

import db from '../../../src/db'
import { processRecurringWithdrawals } from '../../../src/jobs/recurringWithdrawals'
import { executeWithdraw } from '../../../src/controllers/transaction-controller'
import { assessWithdrawal } from '../../../src/services/withdrawal-controls.service'
import { publishUserEvent } from '../../../src/events/publisher'

describe('recurring withdrawal occurrences', () => {
  let plan: any
  beforeEach(() => {
    jest.resetAllMocks()
    plan = {
      id: 'plan',
      userId: 'user',
      destinationAddress: 'GDEST',
      assetSymbol: 'USDC',
      amountMode: 'FIXED',
      amount: 10,
      cadence: 'WEEKLY',
      nextRunAt: new Date(Date.now() - 1000),
      status: 'ACTIVE',
      lastRunStatus: null,
      lastRunAt: null,
    }
    ;(db.recurringWithdrawalPlan.findMany as jest.Mock).mockImplementation(
      async () => [{ ...plan }]
    )
    ;(db.recurringWithdrawalPlan.findUnique as jest.Mock).mockImplementation(
      async () => ({ ...plan })
    )
    ;(db.recurringWithdrawalPlan.updateMany as jest.Mock).mockImplementation(
      async ({ where, data }) => {
        if (
          where.lastRunStatus !== plan.lastRunStatus ||
          where.lastRunAt !== plan.lastRunAt
        )
          return { count: 0 }
        Object.assign(plan, data)
        return { count: 1 }
      }
    )
    ;(db.recurringWithdrawalPlan.update as jest.Mock).mockImplementation(
      async ({ data }) => Object.assign(plan, data)
    )
    ;(db.position.findMany as jest.Mock).mockResolvedValue([
      { currentValue: 100, yieldEarned: 5 },
    ])
    ;(db.transaction.findFirst as jest.Mock).mockResolvedValue({ id: 'known' })
    ;(db.linkedExternalWallet.findFirst as jest.Mock).mockResolvedValue(null)
    ;(db.complianceCase.findFirst as jest.Mock).mockResolvedValue(null)
    ;(db.savingsGoal.findMany as jest.Mock).mockResolvedValue([])
    ;(assessWithdrawal as jest.Mock).mockResolvedValue({ held: false })
    ;(executeWithdraw as jest.Mock).mockResolvedValue({
      status: 'CONFIRMED',
      transaction: { txHash: 'hash' },
    })
    ;(publishUserEvent as jest.Mock).mockResolvedValue(undefined)
  })
  it('claims a never-run plan and uses the manual execution path once across concurrent workers', async () => {
    await Promise.all([
      processRecurringWithdrawals(),
      processRecurringWithdrawals(),
    ])
    expect(executeWithdraw).toHaveBeenCalledTimes(1)
    expect(executeWithdraw).toHaveBeenCalledWith(
      expect.objectContaining({ walletAddress: 'GDEST', amount: 10 })
    )
    expect(plan.nextRunAt.getTime()).toBeGreaterThan(Date.now())
  })
  it('skips insufficient funds without a money movement attempt', async () => {
    ;(db.position.findMany as jest.Mock).mockResolvedValue([
      { currentValue: 1 },
    ])
    await processRecurringWithdrawals()
    expect(executeWithdraw).not.toHaveBeenCalled()
    expect(plan.lastRunStatus).toBe('skipped:insufficient_balance')
    expect(publishUserEvent).toHaveBeenCalledWith(
      'user',
      'alerts',
      'recurring_withdrawal.skipped',
      expect.anything()
    )
  })
  it('pauses unknown destinations and notifies the owner', async () => {
    ;(db.transaction.findFirst as jest.Mock).mockResolvedValue(null)
    await processRecurringWithdrawals()
    expect(plan.status).toBe('PAUSED')
    expect(executeWithdraw).not.toHaveBeenCalled()
    expect(publishUserEvent).toHaveBeenCalledWith(
      'user',
      'alerts',
      'recurring_withdrawal.held',
      expect.anything()
    )
  })
  it('skips goal conflicts with an explanation', async () => {
    ;(db.savingsGoal.findMany as jest.Mock).mockResolvedValue([
      { targetAmount: 95 },
    ])
    await processRecurringWithdrawals()
    expect(executeWithdraw).not.toHaveBeenCalled()
    expect(plan.lastRunStatus).toMatch(/^held_guardrail:/)
    expect(publishUserEvent).toHaveBeenCalledWith(
      'user',
      'alerts',
      'recurring_withdrawal.held',
      expect.objectContaining({ reason: expect.any(String) })
    )
  })
  it('rolls a pending approval forward without repeated requests for the occurrence', async () => {
    ;(executeWithdraw as jest.Mock).mockResolvedValue({
      status: 'PENDING_APPROVAL',
      approvalRequestId: 'approval',
    })
    await processRecurringWithdrawals()
    expect(plan.lastRunStatus).toBe('pending_approval')
    expect(plan.nextRunAt.getTime()).toBeGreaterThan(Date.now())
  })
  it('holds an interrupted submission for review instead of resending', async () => {
    plan.lastRunStatus = 'executing'
    plan.lastRunAt = new Date(Date.now() - 3600000)
    await processRecurringWithdrawals()
    expect(executeWithdraw).not.toHaveBeenCalled()
    expect(plan.status).toBe('PAUSED')
    expect(plan.lastRunStatus).toBe('held:uncertain_execution')
  })
})
