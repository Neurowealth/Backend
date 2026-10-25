// Repayment settlement (#662).
//
// risk.test.ts proves the split is exact. What is tested HERE is that the
// service keeps it exact across the persistence boundary: each confirmed
// repayment re-reads what the previous one wrote, so a single float
// conversion anywhere in that loop would bring the dust back.

process.env.NODE_ENV = 'test'

import { Prisma } from '@prisma/client'
import {
  applyConfirmedRepayment,
  repayLoan,
} from '../../../src/lending/service'
import { toMoney } from '../../../src/lending/risk'

const NOW = new Date('2026-06-01T00:00:00.000Z')

// In-memory CollateralLoan row, written back the way Postgres would store a
// Decimal(36, 18) column.
let row: Record<string, any>
const appliedTransactions = new Set<string>()

jest.mock('../../../src/db', () => {
  const client: any = {
    collateralLoan: {
      findUnique: jest.fn(async () => ({ ...row })),
      update: jest.fn(async ({ data }: any) => {
        for (const [k, v] of Object.entries(data)) {
          row[k] =
            v instanceof Object && 'toFixed' in (v as any)
              ? new Prisma.Decimal((v as any).toFixed(18))
              : v
        }
        return { ...row }
      }),
    },
    transaction: {
      updateMany: jest.fn(async ({ where }: any) => {
        if (appliedTransactions.has(where.id)) return { count: 0 }
        appliedTransactions.add(where.id)
        return { count: 1 }
      }),
      create: jest.fn(async ({ data }: any) => ({ id: 'tx-1', ...data })),
    },
    $transaction: jest.fn(async (fn: any) => fn(client)),
  }
  return { __esModule: true, default: client, db: client }
})

// Accrual is a no-op at a fixed clock; return the row's exact columns.
jest.mock('../../../src/lending/accrual', () => ({
  accrueInterest: jest.fn(async () => ({
    loanId: row.id,
    principalAmount: Number(row.principalAmount),
    interestAccrued: Number(row.interestAccrued),
    interestAccruedTo: row.interestAccruedTo,
    applied: 0,
    principalAmountExact: new Prisma.Decimal(row.principalAmount),
    interestAccruedExact: new Prisma.Decimal(row.interestAccrued),
  })),
}))

const mockEnqueue = jest.fn(async (_tx: unknown, op: any) => ({
  id: 'op-1',
  ...op,
}))
jest.mock('../../../src/outbox/service', () => ({
  enqueueOutboxOp: (tx: unknown, op: unknown) => mockEnqueue(tx, op),
}))
jest.mock('../../../src/outbox/dispatcher', () => ({
  dispatchInBackground: jest.fn(),
}))
jest.mock('../../../src/approvals/service', () => ({
  guardOperation: jest.fn(async () => ({ allowed: true })),
  getActivePolicy: jest.fn(),
}))
jest.mock('../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

const dbMock = require('../../../src/db')

function seedLoan(principal: string, interest: string) {
  row = {
    id: 'loan-1',
    userId: 'user-1',
    positionId: 'pos-1',
    borrowedAsset: 'USDC',
    status: 'ACTIVE',
    principalAmount: new Prisma.Decimal(principal),
    interestAccrued: new Prisma.Decimal(interest),
    interestAccruedTo: NOW,
    // Zero rate: interest cannot move between calls, so every assertion is
    // about the split itself, not about clock drift.
    interestRateApy: new Prisma.Decimal(0),
    position: { user: { network: 'TESTNET', walletAddress: 'GABC' } },
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  appliedTransactions.clear()
})

describe('src/lending/service — applyConfirmedRepayment (#662)', () => {
  it('closes the loan with zero dust after ten 0.1 repayments on 1.0', async () => {
    seedLoan('1', '0')

    const outcomes = []
    for (let i = 0; i < 10; i++) {
      outcomes.push(
        await applyConfirmedRepayment({
          transactionId: `tx-${i}`,
          loanId: 'loan-1',
          amount: new Prisma.Decimal('0.1'),
          now: NOW,
        })
      )
    }

    expect(outcomes.slice(0, 9).every((o) => !o.settled)).toBe(true)
    expect(outcomes[9]).toEqual({ applied: true, settled: true })
    expect(row.status).toBe('REPAID')
    expect(row.principalAmount.toString()).toBe('0')
    expect(row.interestAccrued.toString()).toBe('0')
  })

  it('keeps the loan ACTIVE while a single base unit is still owed', async () => {
    seedLoan('1', '0.000000000000000001')

    for (let i = 0; i < 10; i++) {
      await applyConfirmedRepayment({
        transactionId: `tx-${i}`,
        loanId: 'loan-1',
        amount: '0.1',
        now: NOW,
      })
    }

    expect(row.status).toBe('ACTIVE')
    expect(row.principalAmount.toString()).toBe('1e-18')
  })

  it('applies a repeated confirmation only once', async () => {
    seedLoan('10', '0')

    await applyConfirmedRepayment({
      transactionId: 'tx-dup',
      loanId: 'loan-1',
      amount: '4',
      now: NOW,
    })
    const second = await applyConfirmedRepayment({
      transactionId: 'tx-dup',
      loanId: 'loan-1',
      amount: '4',
      now: NOW,
    })

    expect(second).toEqual({ applied: false, settled: false })
    expect(row.principalAmount.toString()).toBe('6')
  })
})

describe('src/lending/service — repayLoan settlement decision (#662)', () => {
  it('flags an exact full payoff as settling and records the exact amount', async () => {
    seedLoan('1000.123456789012345678', '0.000000000000000001')

    const outcome = await repayLoan({
      loanId: 'loan-1',
      userId: 'user-1',
      skipApprovalGuard: true,
    })

    expect(outcome).toMatchObject({
      status: 'REPAYMENT_QUEUED',
      willSettleLoan: true,
    })
    const created = dbMock.db.transaction.create.mock.calls[0][0].data
    expect(toMoney(created.amount).toFixed(18)).toBe('1000.123456789012345679')
  })

  it('does not flag a payment one base unit short as settling', async () => {
    // The old `amount >= outstanding - 1e-9` check called this settled.
    seedLoan('1', '0.000000000000000001')

    const outcome = await repayLoan({
      loanId: 'loan-1',
      userId: 'user-1',
      amount: 1,
      skipApprovalGuard: true,
    })

    expect(outcome).toMatchObject({ willSettleLoan: false })
  })
})
