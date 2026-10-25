import { TransactionType } from '@prisma/client'
import {
  assertReconciled,
  parseCsv,
  reconcileAccountingExport,
} from '../../../src/accounting/reconciliation'
import { toQbo } from '../../../src/accounting/exporters/qbo'

const tx = (
  overrides: Partial<{
    type: TransactionType
    amount: string
    assetSymbol: string
    fee: string | null
  }> = {}
) => ({
  type: TransactionType.DEPOSIT,
  amount: '100.00',
  assetSymbol: 'USDC',
  fee: null,
  createdAt: new Date('2026-01-02T00:00:00Z'),
  protocolName: null,
  ...overrides,
})

describe('accounting reconciliation (#669)', () => {
  it('parses quoted commas, escaped quotes and CRLF', () => {
    const rows = parseCsv('a,b,c\r\n"x, y","say ""hi""",z\r\nplain,,last')
    expect(rows).toEqual([
      ['a', 'b', 'c'],
      ['x, y', 'say "hi"', 'z'],
      ['plain', '', 'last'],
    ])
  })

  it('blocks an export that drops a row and reports the diff', () => {
    const transactions = [
      tx({ amount: '10' }),
      tx({ amount: '20', assetSymbol: 'BTC' }),
    ]
    const content = toQbo(transactions)
    const truncated = content.split('\r\n').slice(0, -1).join('\r\n')

    const result = reconcileAccountingExport('qbo', truncated, transactions)
    expect(result.reconciled).toBe(false)
    expect(result.diffs.join(' ')).toContain('row count')
    expect(() => assertReconciled('qbo', truncated, transactions)).toThrow(
      /reconciliation failed/i
    )
  })

  it('blocks an export with a duplicated row', () => {
    const transactions = [tx({ amount: '10' })]
    const content = toQbo(transactions)
    const duplicated = `${content}\r\n${content.split('\r\n')[1]}`

    const result = reconcileAccountingExport('qbo', duplicated, transactions)
    expect(result.reconciled).toBe(false)
    expect(result.rowCount).toBe(2)
    expect(result.totals[0]!.diff).toBe('10.00')
  })

  it('blocks an export whose amount or sign was changed', () => {
    const transactions = [
      tx({ type: TransactionType.WITHDRAWAL, amount: '10' }),
    ]
    const content = toQbo(transactions).replace('-10.00', '10.00')
    const result = reconcileAccountingExport('qbo', content, transactions)
    expect(result.reconciled).toBe(false)
    expect(result.totals[0]!.diff).toBe('20.00')
  })

  it('blocks an export with an unexpected header', () => {
    const content = toQbo([tx()]).replace(
      'Date,Description',
      'Description,Date'
    )
    const result = reconcileAccountingExport('qbo', content, [tx()])
    expect(result.reconciled).toBe(false)
    expect(result.diffs.join(' ')).toContain('header mismatch')
  })
})
