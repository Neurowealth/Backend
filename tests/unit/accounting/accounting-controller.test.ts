import { TransactionType } from '@prisma/client'
import db from '../../../src/db'
import { exportAccountingData } from '../../../src/controllers/accounting-controller'

jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: { transaction: { findMany: jest.fn() } },
}))
jest.mock('../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))
jest.mock('../../../src/accounting/exporters', () => ({
  toQbo: jest.fn(),
  toXeroCsv: jest.fn(),
}))

const mockDb = db as any
const exporters = require('../../../src/accounting/exporters') as {
  toQbo: jest.Mock
  toXeroCsv: jest.Mock
}

const rows = [
  {
    type: TransactionType.DEPOSIT,
    amount: '100.00',
    assetSymbol: 'USDC',
    fee: '1.00',
    createdAt: new Date('2026-01-02T00:00:00Z'),
    protocolName: null,
  },
  {
    type: TransactionType.WITHDRAWAL,
    amount: '25.00',
    assetSymbol: 'USDC',
    fee: '0.50',
    createdAt: new Date('2026-01-03T00:00:00Z'),
    protocolName: null,
  },
]

beforeEach(() => {
  jest.clearAllMocks()
  mockDb.transaction.findMany.mockResolvedValue(rows)
})

describe('exportAccountingData (#669)', () => {
  it('returns a downloadable file only after reconciliation succeeds', async () => {
    const { toQbo } = jest.requireActual(
      '../../../src/accounting/exporters/qbo'
    )
    exporters.toQbo.mockImplementation(toQbo)

    const result = await exportAccountingData('user-1', { format: 'qbo' })

    expect(result.success).toBe(true)
    expect(result.data).toContain('Date,Description,Amount')
    expect(result.rowCount).toBe(2)
    expect(result.checksum).toMatch(/^[a-f0-9]{64}$/)
    expect(result.reconciliation?.reconciled).toBe(true)
    expect(result.reconciliation?.totals[0]).toEqual(
      expect.objectContaining({ asset: 'USDC', ledgerAmount: '75.00' })
    )
    expect(result.filename).toMatch(/\.qbo\.csv$/)
  })

  it('blocks the download with a 422 and a diff when rows are dropped', async () => {
    const { toQbo } = jest.requireActual(
      '../../../src/accounting/exporters/qbo'
    )
    const complete = toQbo(rows.map((r) => ({ ...r, amount: r.amount })))
    const truncated = complete.split('\r\n').slice(0, 2).join('\r\n')
    exporters.toQbo.mockReturnValue(truncated)

    const result = await exportAccountingData('user-1', { format: 'qbo' })

    expect(result.success).toBe(false)
    expect(result.data).toBeUndefined()
    expect(result.statusCode).toBe(422)
    expect(result.error).toContain('reconciliation failed')
    expect(result.error).toContain('row count')
    expect(result.reconciliation?.reconciled).toBe(false)
  })

  it('rejects an invalid date range before touching the database', async () => {
    const result = await exportAccountingData('user-1', {
      format: 'qbo',
      from: '2026-02-01',
      to: '2026-01-01',
    })
    expect(result.success).toBe(false)
    expect(result.statusCode).toBe(400)
    expect(mockDb.transaction.findMany).not.toHaveBeenCalled()
  })

  it('succeeds for an empty period with a header-only file', async () => {
    mockDb.transaction.findMany.mockResolvedValue([])
    const { toQbo } = jest.requireActual(
      '../../../src/accounting/exporters/qbo'
    )
    exporters.toQbo.mockImplementation(toQbo)

    const result = await exportAccountingData('user-1', { format: 'qbo' })

    expect(result.success).toBe(true)
    expect(result.rowCount).toBe(0)
    expect(result.reconciliation?.reconciled).toBe(true)
  })
})
