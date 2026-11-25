// Recurring deposits x approval workflows (#314, #833): when a gated occurrence
// returns PENDING_APPROVAL, the plan must advance its slot so the same
// occurrence is not reclaimed on subsequent scheduler ticks (no duplicate
// approval requests / alert spam / duplicate deposits on approval).
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
    recurringDepositRun: {
      create: jest.fn().mockResolvedValue({}),
    },
    custodialWallet: { findUnique: jest.fn() },
    user: { findUnique: jest.fn() },
    protocolRate: { findFirst: jest.fn(), findMany: jest.fn() },
    position: { findMany: jest.fn() },
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

it('marks the occurrence pending_approval, advances nextRunAt, and does not fire failure/executed webhooks', async () => {
  mockExecuteDeposit.mockResolvedValue({
    transaction: null,
    status: 'PENDING_APPROVAL',
    approvalRequestId: 'req-1',
  })

  const originalNextRunAt = plan.nextRunAt
  await processRecurringDeposits()

  const updateCalls = mockDb.recurringDepositPlan.update.mock.calls
  const statusUpdate = updateCalls.find(
    (call: any[]) => call[0].data.lastRunStatus === 'pending_approval'
  )
  expect(statusUpdate).toBeDefined()
  expect(statusUpdate[0].data.nextRunAt).toBeInstanceOf(Date)
  expect(statusUpdate[0].data.nextRunAt.getTime()).toBeGreaterThan(
    originalNextRunAt.getTime()
  )

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

it('does not re-request approval on the next scheduler tick for the same occurrence (#833)', async () => {
  mockExecuteDeposit.mockResolvedValue({
    transaction: null,
    status: 'PENDING_APPROVAL',
    approvalRequestId: 'req-1',
  })

  // Tick 1: plan is due and becomes pending approval with advanced nextRunAt.
  await processRecurringDeposits()
  expect(mockExecuteDeposit).toHaveBeenCalledTimes(1)

  // Tick 2: plan is no longer due (nextRunAt advanced), so no new execution.
  mockDb.recurringDepositPlan.findMany.mockResolvedValueOnce([])
  await processRecurringDeposits()

  expect(mockExecuteDeposit).toHaveBeenCalledTimes(1)
  expect(mockDb.recurringDepositRun.create).toHaveBeenCalledTimes(1)
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

it('keeps the scheduled UTC slot when execution is two hours late', async () => {
  const scheduled = new Date(Date.now() - 2 * 60 * 60 * 1000)
  const late = { ...plan, nextRunAt: scheduled }
  mockDb.recurringDepositPlan.findMany.mockResolvedValue([late])
  mockDb.recurringDepositPlan.findUnique.mockResolvedValue(late)
  mockExecuteDeposit.mockResolvedValue({
    status: 'CONFIRMED',
    transaction: { txHash: 'hash' },
  })
  await processRecurringDeposits()
  expect(mockDb.recurringDepositPlan.update).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        nextRunAt: new Date(scheduled.getTime() + 7 * 86400000),
      }),
    })
  )
})

it('uses only one protocol on the planned asset and user network', async () => {
  const adaptive = { ...plan, policy: 'ADAPTIVE' }
  mockDb.recurringDepositPlan.findMany.mockResolvedValue([adaptive])
  mockDb.recurringDepositPlan.findUnique.mockResolvedValue(adaptive)
  mockDb.user.findUnique.mockResolvedValue({ network: 'TESTNET' })
  mockDb.protocolRate.findFirst.mockResolvedValue({ protocolName: 'Blend' })
  const rates = Array.from({ length: 6 }, (_, i) => [
    {
      assetSymbol: 'USDC',
      network: 'TESTNET',
      protocolName: 'Blend',
      supplyApy: 0.05,
    },
    {
      assetSymbol: 'XLM',
      network: 'TESTNET',
      protocolName: 'Blend',
      supplyApy: i % 2 ? 0.01 : 0.2,
    },
    {
      assetSymbol: 'USDC',
      network: 'MAINNET',
      protocolName: 'Blend',
      supplyApy: 0.2,
    },
    {
      assetSymbol: 'USDC',
      network: 'TESTNET',
      protocolName: 'Other',
      supplyApy: 0.2,
    },
  ]).flat()
  mockDb.protocolRate.findMany.mockImplementation(async ({ where }: any) =>
    rates.filter(
      (rate) =>
        rate.assetSymbol === where.assetSymbol &&
        rate.network === where.network &&
        rate.protocolName === where.protocolName
    )
  )
  mockDb.position.findMany.mockResolvedValue([])
  mockExecuteDeposit.mockResolvedValue({
    status: 'CONFIRMED',
    transaction: { txHash: 'hash' },
  })
  await processRecurringDeposits()
  expect(mockDb.recurringDepositRun.create).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        regimeSnapshot: expect.objectContaining({
          regime: 'NORMAL',
          regimeInput: expect.objectContaining({ recentValuesCount: 6 }),
        }),
      }),
    })
  )
})

it('records one skipped run for a plan three cadences overdue', async () => {
  const overdue = {
    ...plan,
    amount: 0,
    catchUpMode: 'SKIP',
    nextRunAt: new Date(Date.now() - 22 * 86400000),
  }
  mockDb.recurringDepositPlan.findMany.mockResolvedValue([overdue])
  mockDb.recurringDepositPlan.findUnique.mockResolvedValue(overdue)
  mockDb.recurringDepositPlan.update.mockImplementation(async ({ data }: any) =>
    Object.assign(overdue, data)
  )
  await processRecurringDeposits()
  expect(overdue.nextRunAt.getTime()).toBeGreaterThan(Date.now())
  await processRecurringDeposits()
  expect(mockDb.recurringDepositRun.create).toHaveBeenCalledTimes(1)
  expect(mockExecuteDeposit).not.toHaveBeenCalled()
})
