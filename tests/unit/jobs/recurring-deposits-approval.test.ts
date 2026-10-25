// Recurring deposits x approval workflows (#314): a plan gated by an
// ApprovalPolicy must be skipped, not treated as a failure — no
// recurring_deposit.failed webhook, nextRunAt left untouched so the next
// sweep re-evaluates it (landing on the same open request via
// guardOperation's dedupe, not a new one every tick).
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
    recurringDepositPlan: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
      update: jest.fn(),
    },
    custodialWallet: { findUnique: jest.fn() },
    transaction: { findFirst: jest.fn().mockResolvedValue(null) },
  },
}))
jest.mock('../../../src/controllers/transaction-controller', () => ({
  executeDeposit: jest.fn(),
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
import { executeDeposit } from '../../../src/controllers/transaction-controller'
import { publishUserEvent } from '../../../src/events/publisher'
import {
  processRecurringDeposits,
  isExecutingClaimStale,
} from '../../../src/jobs/recurringDeposits'

const mockDb = db as any
const mockExecuteDeposit = executeDeposit as jest.Mock
const mockPublish = publishUserEvent as jest.Mock

const plan = {
  id: 'plan-1',
  userId: 'user-1',
  amount: 5000,
  assetSymbol: 'USDC',
  cadence: 'WEEKLY',
  status: 'ACTIVE',
  nextRunAt: new Date(Date.now() - 1000),
  lastRunStatus: null,
}

beforeEach(() => {
  jest.clearAllMocks()
  mockDb.recurringDepositPlan.findMany.mockResolvedValue([plan])
  mockDb.recurringDepositPlan.findUnique.mockResolvedValue(plan)
  mockDb.recurringDepositPlan.updateMany.mockResolvedValue({ count: 1 })
  mockDb.recurringDepositPlan.update.mockResolvedValue({})
  mockDb.custodialWallet.findUnique.mockResolvedValue({
    publicKey: 'G...WALLET',
  })
})

it('marks the occurrence pending_approval without advancing nextRunAt or firing a failure webhook', async () => {
  mockExecuteDeposit.mockResolvedValue({
    transaction: null,
    status: 'PENDING_APPROVAL',
    approvalRequestId: 'req-1',
  })

  await processRecurringDeposits()

  const updateCalls = mockDb.recurringDepositPlan.update.mock.calls
  const statusUpdate = updateCalls.find(
    (call: any[]) => call[0].data.lastRunStatus === 'pending_approval'
  )
  expect(statusUpdate).toBeDefined()
  expect(statusUpdate[0].data.nextRunAt).toBeUndefined()

  expect(mockPublish).not.toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    'recurring_deposit.failed',
    expect.anything()
  )
  expect(mockPublish).not.toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    'recurring_deposit.executed',
    expect.anything()
  )
})

it('still executes normally when the guard allows (CONFIRMED)', async () => {
  mockExecuteDeposit.mockResolvedValue({
    transaction: { id: 'tx-1', txHash: '0xabc' },
    status: 'CONFIRMED',
  })

  await processRecurringDeposits()

  expect(mockPublish).toHaveBeenCalledWith(
    'user-1',
    expect.anything(),
    'recurring_deposit.executed',
    expect.objectContaining({ planId: 'plan-1' })
  )
})

it('does not resume a fresh executing claim', async () => {
  const executing = {
    ...plan,
    lastRunStatus: 'executing',
    lastRunAt: new Date(),
  }
  mockDb.recurringDepositPlan.findMany.mockResolvedValue([executing])

  await processRecurringDeposits()

  expect(mockExecuteDeposit).not.toHaveBeenCalled()
  expect(mockDb.transaction.findFirst).not.toHaveBeenCalled()
})

it('completes a stale executing plan from the deposit that already confirmed', async () => {
  const stale = {
    ...plan,
    lastRunStatus: 'executing',
    lastRunAt: new Date(Date.now() - 11 * 60 * 1000),
  }
  mockDb.recurringDepositPlan.findMany.mockResolvedValue([stale])
  mockDb.transaction.findFirst.mockResolvedValue({
    id: 'tx-confirmed',
    status: 'CONFIRMED',
  })

  await processRecurringDeposits()

  expect(mockExecuteDeposit).not.toHaveBeenCalled()
  expect(mockDb.recurringDepositPlan.update).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { id: 'plan-1' },
      data: expect.objectContaining({ lastRunStatus: 'executed' }),
    })
  )
})

it('reclaims a stale executing plan when no deposit was persisted', async () => {
  const stale = {
    ...plan,
    lastRunStatus: 'executing',
    lastRunAt: new Date(Date.now() - 11 * 60 * 1000),
  }
  mockDb.recurringDepositPlan.findMany.mockResolvedValue([stale])
  mockDb.recurringDepositPlan.findUnique.mockResolvedValue(stale)
  mockDb.transaction.findFirst.mockResolvedValue(null)
  mockExecuteDeposit.mockResolvedValue({
    transaction: { id: 'tx-2', txHash: '0xdef' },
    status: 'CONFIRMED',
  })

  await processRecurringDeposits()

  expect(mockExecuteDeposit).toHaveBeenCalled()
})

it('treats a missing lastRunAt on an executing plan as stale', () => {
  expect(
    isExecutingClaimStale(
      { lastRunStatus: 'executing', lastRunAt: null },
      new Date()
    )
  ).toBe(true)
  expect(
    isExecutingClaimStale(
      { lastRunStatus: 'executing', lastRunAt: new Date() },
      new Date()
    )
  ).toBe(false)
  expect(
    isExecutingClaimStale({ lastRunStatus: null, lastRunAt: null }, new Date())
  ).toBe(false)
})
