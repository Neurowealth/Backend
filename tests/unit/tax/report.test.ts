// Tax report assembly tests (#284): totals include only fully priced
// disposals (unpriced flagged in caveats, never zeroed), UTC year bounds on
// disposedAt, and an empty year is still a valid report.
import db from '../../../src/db'
import {
  buildTaxReport,
  taxReportToCsvRows,
  TAX_REPORT_CSV_HEADERS,
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
  })
})
