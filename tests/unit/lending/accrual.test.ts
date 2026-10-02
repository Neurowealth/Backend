// Interest accrual (#532).
//
// The arithmetic is in risk.ts and tested there. What is tested HERE is the
// persistence contract around it, because that is where a user's bill goes
// wrong quietly:
//
//   1. The watermark is a compare-and-swap: two accruals for the same window
//      must never both persist their delta.
//   2. Losing that race reports the WINNER's numbers, not ours on top of
//      theirs.
//   3. A settled loan is never re-accrued.
//   4. A clock that did not move writes nothing.
//   5. One poisoned loan does not stop the rest of the book.

process.env.NODE_ENV = 'test'

import {
  accrueAllActiveLoans,
  accrueInterest,
} from '../../../src/lending/accrual'

jest.mock('../../../src/db', () => {
  const findUnique = jest.fn()
  const updateMany = jest.fn()
  const findMany = jest.fn()
  const client: any = {
    collateralLoan: { findUnique, updateMany, findMany },
  }
  return {
    __esModule: true,
    default: client,
    db: client,
    __mockFindUnique: findUnique,
    __mockUpdateMany: updateMany,
    __mockFindMany: findMany,
  }
})

jest.mock('../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

const dbMock = require('../../../src/db')
const mockFindUnique: jest.Mock = dbMock.__mockFindUnique
const mockUpdateMany: jest.Mock = dbMock.__mockUpdateMany
const mockFindMany: jest.Mock = dbMock.__mockFindMany

const FROM = new Date('2026-01-01T00:00:00.000Z')
/** 365.25 days later: 8% of 10,000 for a full year is 800. */
const TO = new Date(FROM.getTime() + 365.25 * 24 * 60 * 60 * 1000)

function loan(overrides: Record<string, unknown> = {}) {
  return {
    id: 'loan-1',
    status: 'ACTIVE',
    principalAmount: 10_000,
    interestAccrued: 0,
    interestAccruedTo: FROM,
    // PERCENT, matching ProtocolRate.borrowApy: 8 means 8%, not 0.08.
    interestRateApy: 8,
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockUpdateMany.mockResolvedValue({ count: 1 })
})

describe('src/lending/accrual — accrueInterest', () => {
  it('charges a year of interest at the frozen rate, with the rate read as PERCENT', async () => {
    // 8% of 10,000 for 365.25 days is 800. If the rate were treated as a
    // fraction this would be 8 — a 100x under-charge the platform would never
    // notice, because it is the kind of error that only shows up as a slowly
    // shrinking lending margin.
    mockFindUnique.mockResolvedValue(loan({ interestRateApy: 8 }))

    const result = await accrueInterest('loan-1', TO)

    expect(result.applied).toBeCloseTo(800, 6)
  })

  it('writes the window it is given and moves the watermark to it', async () => {
    mockFindUnique.mockResolvedValue(loan())

    const result = await accrueInterest('loan-1', TO)

    expect(result).toMatchObject({ loanId: 'loan-1', interestAccruedTo: TO })
    expect(result.applied).toBeCloseTo(800, 6)
    expect(mockUpdateMany).toHaveBeenCalledTimes(1)
    // The old timestamp in the WHERE clause IS the concurrency control.
    const call = mockUpdateMany.mock.calls[0][0]
    expect(call.where).toEqual({
      id: 'loan-1',
      status: 'ACTIVE',
      interestAccruedTo: FROM,
    })
    expect(call.data.interestAccruedTo).toEqual(TO)
    expect(call.data.interestAccrued).toEqual({ increment: 800 })
  })

  it('accrues the same total whether the window arrives in one piece or ten', async () => {
    // A missed job tick must cost the user nothing: 10 x 36.5 days has to
    // equal 365 days, or the bill would depend on the platform's uptime.
    const oneStep = await (async () => {
      mockFindUnique.mockResolvedValue(loan())
      const r = await accrueInterest('loan-1', TO)
      return r.applied
    })()

    const tenSteps = await (async () => {
      let running = 0
      let watermark = FROM
      let accrued = 0
      for (let i = 1; i <= 10; i++) {
        const next = new Date(
          FROM.getTime() + (i * (365.25 * 24 * 60 * 60 * 1000)) / 10
        )
        mockFindUnique.mockResolvedValue(
          loan({ interestAccruedTo: watermark, interestAccrued: accrued })
        )
        const r = await accrueInterest('loan-1', next)
        running += r.applied
        accrued = r.interestAccrued
        watermark = r.interestAccruedTo
      }
      return running
    })()

    expect(tenSteps).toBeCloseTo(oneStep, 6)
  })

  it('is a no-op when the clock has not moved', async () => {
    mockFindUnique.mockResolvedValue(loan())

    const result = await accrueInterest('loan-1', FROM)

    expect(result.applied).toBe(0)
    expect(result.interestAccrued).toBe(0)
    expect(mockUpdateMany).not.toHaveBeenCalled()
  })

  it('does not re-accrue a settled loan', async () => {
    // Re-accruing a REPAID loan would quietly add interest to a debt the user
    // has already cleared, and the loan row outlives the balance it records.
    mockFindUnique.mockResolvedValue(loan({ status: 'REPAID' }))

    const result = await accrueInterest('loan-1', TO)

    expect(result.applied).toBe(0)
    expect(result.interestAccruedTo).toEqual(FROM)
    expect(mockUpdateMany).not.toHaveBeenCalled()
  })

  it('throws for a loan that does not exist rather than accruing nothing', async () => {
    mockFindUnique.mockResolvedValue(null)
    await expect(accrueInterest('missing', TO)).rejects.toThrow(/missing/)
  })

  describe('when it loses the compare-and-swap race', () => {
    it("reports the winner's numbers instead of double-charging", async () => {
      // Two writers read the same watermark and compute the same 800. Only one
      // may persist it. A plain `update` here would let the loser write on top
      // of the winner and bill the user 1,600 for one year of interest.
      mockFindUnique.mockResolvedValue(loan())
      mockUpdateMany.mockResolvedValue({ count: 0 })
      mockFindUnique
        .mockResolvedValueOnce(loan())
        .mockResolvedValueOnce(
          loan({ interestAccrued: 800, interestAccruedTo: TO })
        )

      const result = await accrueInterest('loan-1', TO)

      expect(result.applied).toBe(0)
      expect(result.interestAccrued).toBe(800)
      expect(result.interestAccruedTo).toEqual(TO)
    })

    it('still makes exactly one conditional write attempt', async () => {
      mockFindUnique.mockResolvedValue(loan())
      mockUpdateMany.mockResolvedValue({ count: 0 })
      mockFindUnique.mockResolvedValueOnce(loan())

      await accrueInterest('loan-1', TO)
      expect(mockUpdateMany).toHaveBeenCalledTimes(1)
    })
  })
})

describe('src/lending/accrual — accrueAllActiveLoans', () => {
  it('bounds the batch and totals what it applied', async () => {
    mockFindMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }])
    mockFindUnique.mockImplementation(async ({ where }: any) =>
      loan({ id: where.id, interestAccrued: 400 })
    )

    const result = await accrueAllActiveLoans({ now: TO, limit: 2 })

    expect(result).toMatchObject({ processed: 2, failed: 0 })
    expect(result.totalInterestApplied).toBeCloseTo(1600, 6)
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 2, where: { status: 'ACTIVE' } })
    )
  })

  it('isolates a failing loan so the rest of the book still gets brought current', async () => {
    mockFindMany.mockResolvedValue([{ id: 'bad' }, { id: 'good' }])
    mockFindUnique.mockImplementation(async ({ where }: any) => {
      if (where.id === 'bad') throw new Error('connection reset')
      return loan({ id: 'good' })
    })

    const result = await accrueAllActiveLoans({ now: TO })

    expect(result).toMatchObject({ processed: 2, failed: 1 })
    expect(result.totalInterestApplied).toBeCloseTo(800, 6)
  })
})
