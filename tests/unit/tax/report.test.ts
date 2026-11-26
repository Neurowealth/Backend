// Tax report assembly tests (#284, extended by #317): totals include only
// fully priced disposals (unpriced flagged in caveats, never zeroed), UTC
// year bounds on disposedAt, an empty year is still a valid report, and
// method selection is a confirmation gate (not a recompute switch).
import db from '../../../src/db'
import {
  buildTaxReport,
  taxReportToCsvRows,
  TAX_REPORT_CSV_HEADERS,
  MethodMismatchError,
} from '../../../src/tax/report'

jest.mock('../../../src/db', () => ({ __esModule: true, default: {} }))
jest.mock('../../../src/utils/logger', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}))

const mockDb = db as any

function disposalRow(overrides: Record<string, any> = {}) {
  return {
    disposedAt: new Date('2026-06-15T12:00:00Z'),
    assetSymbol: 'USDC',
    amount: '40',
    disposalPrice: '1',
    costBasis: '40',
    proceeds: '40',
    realizedGain: '0',
    transaction: { txHash: 'withdraw-hash' },
    lot: {
      acquiredAt: new Date('2026-01-15T00:00:00Z'),
      acquisitionPrice: '1',
      transaction: { txHash: 'deposit-hash' },
    },
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockDb.lotDisposal = { findMany: jest.fn() }
  mockDb.user = {
    findUnique: jest.fn().mockResolvedValue({
      accountingMethod: 'FIFO',
      methodEffectiveAt: null,
      taxJurisdiction: 'US',
    }),
  }
})

describe('buildTaxReport', () => {
  it('returns a valid empty report for a year with no activity', async () => {
    mockDb.lotDisposal.findMany.mockResolvedValue([])

    const report = await buildTaxReport('user-1', 2026)

    expect(report).toMatchObject({
      userId: 'user-1',
      year: 2026,
      method: 'FIFO',
      disposals: [],
      totals: {
        proceeds: '0',
        costBasis: '0',
        realizedGain: '0',
        pricedDisposalCount: 0,
      },
    })
    expect(report.caveats.unpricedDisposalCount).toBe(0)
  })

  it('queries with UTC year boundaries on disposedAt', async () => {
    mockDb.lotDisposal.findMany.mockResolvedValue([])

    await buildTaxReport('user-1', 2026)

    const where = mockDb.lotDisposal.findMany.mock.calls[0][0].where
    expect(where.userId).toBe('user-1')
    expect(where.disposedAt.gte.toISOString()).toBe('2026-01-01T00:00:00.000Z')
    expect(where.disposedAt.lt.toISOString()).toBe('2027-01-01T00:00:00.000Z')
  })

  it('totals include only fully priced disposals; unpriced are flagged', async () => {
    mockDb.lotDisposal.findMany.mockResolvedValue([
      disposalRow({ proceeds: '40', costBasis: '30', realizedGain: '10' }),
      disposalRow({
        assetSymbol: 'XLM',
        disposalPrice: null,
        costBasis: null,
        proceeds: null,
        realizedGain: null,
        lot: {
          acquiredAt: new Date('2026-02-01T00:00:00Z'),
          acquisitionPrice: null,
          transaction: { txHash: 'xlm-deposit-hash' },
        },
      }),
    ])

    const report = await buildTaxReport('user-1', 2026)

    expect(report.totals).toEqual({
      proceeds: '40',
      costBasis: '30',
      realizedGain: '10',
      pricedDisposalCount: 1,
      shortTermGain: '10',
      longTermGain: '0',
      allowanceApplied: '0',
      realizedGainAfterAllowance: '10',
      exemptGain: '0',
      discountApplied: '0',
      taxableGain: '10',
      taxableGainAfterAllowance: '10',
    })
    expect(report.caveats.unpricedDisposalCount).toBe(1)
    expect(report.caveats.unpricedAssets).toEqual(['XLM'])
    expect(report.disposals[0].priced).toBe(true)
    expect(report.disposals[1].priced).toBe(false)
    expect(report.disposals[1].realizedGain).toBeNull()
  })

  it('reports a year-spanning lot by disposal year, keeping acquisition info', async () => {
    mockDb.lotDisposal.findMany.mockResolvedValue([
      disposalRow({
        disposedAt: new Date('2027-03-01T00:00:00Z'),
        lot: {
          acquiredAt: new Date('2026-11-01T00:00:00Z'),
          acquisitionPrice: '1',
          transaction: { txHash: 'deposit-hash' },
        },
      }),
    ])

    const report = await buildTaxReport('user-1', 2027)

    expect(report.disposals[0].acquiredAt).toBe('2026-11-01T00:00:00.000Z')
    expect(report.disposals[0].acquisitionTxHash).toBe('deposit-hash')
    expect(report.disposals[0].withdrawalTxHash).toBe('withdraw-hash')
  })

  it('reports the method column from the account, not a hardcoded literal', async () => {
    mockDb.user.findUnique.mockResolvedValue({
      accountingMethod: 'HIFO',
      methodEffectiveAt: null,
      taxJurisdiction: 'US',
    })
    mockDb.lotDisposal.findMany.mockResolvedValue([])

    const report = await buildTaxReport('user-1', 2026)

    expect(report.method).toBe('HIFO')
  })

  it('accepts a requested method that matches the account setting', async () => {
    mockDb.user.findUnique.mockResolvedValue({
      accountingMethod: 'LIFO',
      methodEffectiveAt: null,
      taxJurisdiction: 'US',
    })
    mockDb.lotDisposal.findMany.mockResolvedValue([])

    const report = await buildTaxReport('user-1', 2026, 'LIFO' as any)

    expect(report.method).toBe('LIFO')
  })

  it('rejects a requested method that does not match the account setting', async () => {
    mockDb.user.findUnique.mockResolvedValue({
      accountingMethod: 'FIFO',
      methodEffectiveAt: null,
    })

    await expect(buildTaxReport('user-1', 2026, 'LIFO' as any)).rejects.toThrow(
      MethodMismatchError
    )
    expect(mockDb.lotDisposal.findMany).not.toHaveBeenCalled()
  })

  it('flags a mid-year method change instead of silently mixing methods', async () => {
    mockDb.user.findUnique.mockResolvedValue({
      accountingMethod: 'HIFO',
      methodEffectiveAt: new Date('2026-06-01T00:00:00Z'),
      taxJurisdiction: 'US',
    })
    mockDb.lotDisposal.findMany.mockResolvedValue([])

    const report = await buildTaxReport('user-1', 2026)

    expect(report.caveats.methodChangeNote).toMatch(/HIFO/)
  })

  it('does not flag a method change outside the report year', async () => {
    mockDb.user.findUnique.mockResolvedValue({
      accountingMethod: 'HIFO',
      methodEffectiveAt: new Date('2025-06-01T00:00:00Z'),
      taxJurisdiction: 'US',
    })
    mockDb.lotDisposal.findMany.mockResolvedValue([])

    const report = await buildTaxReport('user-1', 2026)

    expect(report.caveats.methodChangeNote).toBeNull()
  })
})

describe('buildTaxReport — jurisdiction long-term treatment (#839)', () => {
  function asJurisdiction(taxJurisdiction: string) {
    mockDb.user.findUnique.mockResolvedValue({
      accountingMethod: 'FIFO',
      methodEffectiveAt: null,
      taxJurisdiction,
    })
  }

  // Held ~2 years: long-term in every profile.
  const longHeld = (
    realizedGain: string,
    disposedAt = '2026-06-15T12:00:00Z'
  ) =>
    disposalRow({
      disposedAt: new Date(disposedAt),
      proceeds: '100',
      costBasis: String(100 - Number(realizedGain)),
      realizedGain,
      lot: {
        acquiredAt: new Date('2024-06-01T00:00:00Z'),
        acquisitionPrice: '1',
        transaction: { txHash: 'old-deposit' },
      },
    })
  // Held ~1 month: short-term in every profile with a threshold.
  const shortHeld = (
    realizedGain: string,
    disposedAt = '2026-06-15T12:00:00Z'
  ) =>
    disposalRow({
      disposedAt: new Date(disposedAt),
      proceeds: '100',
      costBasis: String(100 - Number(realizedGain)),
      realizedGain,
      lot: {
        acquiredAt: new Date('2026-05-15T00:00:00Z'),
        acquisitionPrice: '1',
        transaction: { txHash: 'new-deposit' },
      },
    })

  it('DE (FULL_EXEMPTION): long-term gains do not count towards taxable gain', async () => {
    asJurisdiction('DE')
    mockDb.lotDisposal.findMany.mockResolvedValue([
      longHeld('40'),
      shortHeld('10'),
    ])

    const report = await buildTaxReport('user-1', 2026)

    expect(report.totals).toMatchObject({
      realizedGain: '50',
      longTermGain: '40',
      shortTermGain: '10',
      exemptGain: '40',
      discountApplied: '0',
      taxableGain: '10',
      taxableGainAfterAllowance: '10',
    })
    // The raw gain stays visible per disposal.
    expect(report.disposals[0]).toMatchObject({
      realizedGain: '40',
      taxableGain: '0',
      longTerm: true,
    })
    expect(report.disposals[1].taxableGain).toBe('10')
  })

  it('DE: an exempt long-term loss is not deductible either', async () => {
    asJurisdiction('DE')
    mockDb.lotDisposal.findMany.mockResolvedValue([
      longHeld('-30'),
      shortHeld('10'),
    ])

    const report = await buildTaxReport('user-1', 2026)

    expect(report.totals).toMatchObject({
      realizedGain: '-20',
      exemptGain: '-30',
      taxableGain: '10',
    })
  })

  it('AU (FLAT_DISCOUNT 50%): eligible long-term gains are halved; short-term are not', async () => {
    asJurisdiction('AU')
    // AU tax year 2025 runs 2025-07-01 to 2026-06-30.
    mockDb.lotDisposal.findMany.mockResolvedValue([
      longHeld('40'),
      shortHeld('10'),
    ])

    const report = await buildTaxReport('user-1', 2025)

    expect(report.totals).toMatchObject({
      realizedGain: '50',
      longTermGain: '40',
      discountApplied: '20',
      exemptGain: '0',
      taxableGain: '30',
      taxableGainAfterAllowance: '30',
    })
    expect(report.disposals[0].taxableGain).toBe('20')
    expect(report.disposals[1].taxableGain).toBe('10')
  })

  it('CA (FLAT_DISCOUNT 50% from day one): every gain is included at 50%', async () => {
    asJurisdiction('CA')
    mockDb.lotDisposal.findMany.mockResolvedValue([
      longHeld('40'),
      shortHeld('10'),
    ])

    const report = await buildTaxReport('user-1', 2026)

    expect(report.totals).toMatchObject({
      realizedGain: '50',
      discountApplied: '25',
      taxableGain: '25',
    })
  })

  it('US (RATE_SPLIT) and UK (NONE) leave the gain undiscounted', async () => {
    asJurisdiction('US')
    mockDb.lotDisposal.findMany.mockResolvedValue([longHeld('40')])
    const us = await buildTaxReport('user-1', 2026)
    expect(us.totals).toMatchObject({
      taxableGain: '40',
      discountApplied: '0',
      exemptGain: '0',
    })

    asJurisdiction('UK')
    const uk = await buildTaxReport('user-1', 2026)
    expect(uk.totals).toMatchObject({ taxableGain: '40', realizedGain: '40' })
  })

  it('UK: the annual exempt amount is applied against the taxable gain', async () => {
    asJurisdiction('UK')
    mockDb.lotDisposal.findMany.mockResolvedValue([longHeld('5000')])

    const report = await buildTaxReport('user-1', 2026)

    expect(report.totals).toMatchObject({
      allowanceApplied: '3000',
      realizedGainAfterAllowance: '2000',
      taxableGainAfterAllowance: '2000',
    })
  })

  it('unpriced disposals have no taxable gain and stay out of the totals', async () => {
    asJurisdiction('DE')
    mockDb.lotDisposal.findMany.mockResolvedValue([
      longHeld('40'),
      disposalRow({ realizedGain: null, proceeds: null, costBasis: null }),
    ])

    const report = await buildTaxReport('user-1', 2026)

    expect(report.disposals[1].taxableGain).toBeNull()
    expect(report.totals.exemptGain).toBe('40')
  })
})

describe('buildTaxReport — UK/AU tax-year boundaries (#844)', () => {
  function asJurisdiction(taxJurisdiction: string) {
    mockDb.user.findUnique.mockResolvedValue({
      accountingMethod: 'FIFO',
      methodEffectiveAt: null,
      taxJurisdiction,
    })
  }

  it('UK: year=2025 selects 6 Apr 2025 to 5 Apr 2026, labelled 2025-26', async () => {
    asJurisdiction('UK')
    mockDb.lotDisposal.findMany.mockResolvedValue([])

    const report = await buildTaxReport('user-1', 2025)

    const where = mockDb.lotDisposal.findMany.mock.calls[0][0].where
    expect(where.disposedAt.gte.toISOString()).toBe('2025-04-06T00:00:00.000Z')
    expect(where.disposedAt.lt.toISOString()).toBe('2026-04-06T00:00:00.000Z')
    expect(report).toMatchObject({
      year: 2025,
      taxYearLabel: '2025-26',
      taxYearStart: '2025-04-06T00:00:00.000Z',
      taxYearEnd: '2026-04-06T00:00:00.000Z',
    })
    expect(report.caveats.taxYearNote).toBe(
      'United Kingdom tax year 2025-26: 2025-04-06 to 2026-04-05 inclusive (UTC). year=2025 selects the tax year that starts in 2025.'
    )
  })

  it('AU: year=2025 selects 1 Jul 2025 to 30 Jun 2026, labelled 2025-26', async () => {
    asJurisdiction('AU')
    mockDb.lotDisposal.findMany.mockResolvedValue([])

    const report = await buildTaxReport('user-1', 2025)

    expect(report).toMatchObject({
      taxYearLabel: '2025-26',
      taxYearStart: '2025-07-01T00:00:00.000Z',
      taxYearEnd: '2026-07-01T00:00:00.000Z',
    })
    expect(report.caveats.taxYearNote).toMatch(
      /2025-07-01 to 2026-06-30 inclusive/
    )
  })

  it('a calendar-year note does not mention start-year selection', async () => {
    mockDb.lotDisposal.findMany.mockResolvedValue([])

    const report = await buildTaxReport('user-1', 2026)

    expect(report.caveats.taxYearNote).toBe(
      'United States tax year 2026: 2026-01-01 to 2026-12-31 inclusive (UTC).'
    )
  })
})

describe('taxReportToCsvRows', () => {
  it('produces one row per disposal aligned with the headers', async () => {
    mockDb.lotDisposal.findMany.mockResolvedValue([disposalRow()])

    const report = await buildTaxReport('user-1', 2026)
    const rows = taxReportToCsvRows(report)

    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveLength(TAX_REPORT_CSV_HEADERS.length)
    expect(rows[0][TAX_REPORT_CSV_HEADERS.indexOf('amount')]).toBe('40')
    expect(rows[0][TAX_REPORT_CSV_HEADERS.indexOf('priced')]).toBe(true)
    expect(rows[0][TAX_REPORT_CSV_HEADERS.indexOf('taxableGain')]).toBe('0')
  })
})
