import fs from 'node:fs'
import path from 'node:path'
import { TransactionType } from '@prisma/client'
import { toQbo } from '../../../src/accounting/exporters/qbo'
import { toXeroCsv } from '../../../src/accounting/exporters/xeroCsv'
import {
  computeLedgerTotals,
  parseCsv,
  reconcileAccountingExport,
} from '../../../src/accounting/reconciliation'

const FIXTURES = path.join(__dirname, '../../fixtures/accounting')

const transactions = [
  {
    type: TransactionType.DEPOSIT,
    amount: '1000.5000',
    assetSymbol: 'USDC',
    fee: '1.2500',
    createdAt: new Date('2026-01-02T10:00:00Z'),
    protocolName: 'Aave, V3',
  },
  {
    type: TransactionType.WITHDRAWAL,
    amount: '250.00',
    assetSymbol: 'USDC',
    fee: '0.50',
    createdAt: new Date('2026-01-03T10:00:00Z'),
    protocolName: null,
  },
  {
    type: TransactionType.YIELD_CLAIM,
    amount: '12.345',
    assetSymbol: 'USDC',
    fee: null,
    createdAt: new Date('2026-01-04T10:00:00Z'),
    protocolName: 'Yield "bonus"',
  },
  {
    type: TransactionType.DEPOSIT,
    amount: '0.50000000',
    assetSymbol: 'BTC',
    fee: '0',
    createdAt: new Date('2026-02-01T10:00:00Z'),
    protocolName: null,
  },
  {
    type: TransactionType.REBALANCE,
    amount: '99',
    assetSymbol: 'USDC',
    fee: null,
    createdAt: new Date('2026-02-02T10:00:00Z'),
    protocolName: null,
  },
]

describe('accounting export golden files (#669)', () => {
  it('matches the QBO golden file exactly', () => {
    const golden = fs.readFileSync(
      path.join(FIXTURES, 'qbo.golden.csv'),
      'utf8'
    )
    expect(toQbo(transactions)).toBe(golden)
  })

  it('matches the Xero golden file exactly', () => {
    const golden = fs.readFileSync(
      path.join(FIXTURES, 'xero.golden.csv'),
      'utf8'
    )
    expect(toXeroCsv(transactions)).toBe(golden)
  })

  it('round-trips QBO: headers, escaping, signs, fees and multi-currency', () => {
    const rows = parseCsv(toQbo(transactions))
    expect(rows[0]).toEqual([
      'Date',
      'Description',
      'Amount',
      'Category',
      'Asset',
      'Fee',
    ])
    expect(rows[1]).toEqual([
      '2026-01-02',
      'DEPOSIT - Aave, V3',
      '1000.50',
      'Transfer In',
      'USDC',
      '1.25',
    ])
    expect(rows[2]![2]).toBe('-250.00')
    expect(rows[3]![1]).toBe('YIELD_CLAIM - Yield "bonus"')
    expect(rows[4]![4]).toBe('BTC')
    expect(rows[5]![2]).toBe('0.00')
  })

  it('round-trips Xero and reconciles to ledger totals per asset', () => {
    const content = toXeroCsv(transactions)
    const result = reconcileAccountingExport('xero-csv', content, transactions)
    expect(result.reconciled).toBe(true)
    expect(result.rowCount).toBe(transactions.length)
    expect(result.totals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ asset: 'USDC', ledgerAmount: '761.10' }),
        expect.objectContaining({ asset: 'BTC', ledgerAmount: '0.50' }),
      ])
    )
  })

  it('reconciles Xero net amounts when a sub-cent fee rounds at the boundary', () => {
    const rows = [
      {
        type: TransactionType.DEPOSIT,
        amount: '10.005',
        assetSymbol: 'USDC',
        fee: '0.004',
        createdAt: new Date('2026-03-01T00:00:00Z'),
        protocolName: null,
      },
    ]
    const result = reconcileAccountingExport('xero-csv', toXeroCsv(rows), rows)
    expect(result.reconciled).toBe(true)
    expect(result.totals[0]!.ledgerAmount).toBe('10.00')
  })

  it('reconciles QBO gross amounts and fees independently', () => {
    const result = reconcileAccountingExport(
      'qbo',
      toQbo(transactions),
      transactions
    )
    expect(result.reconciled).toBe(true)
    const usdc = result.totals.find((t) => t.asset === 'USDC')!
    expect(usdc.ledgerAmount).toBe('762.85')
    expect(usdc.ledgerFee).toBe('1.75')
  })

  it('computes ledger totals without using the generated text', () => {
    const totals = computeLedgerTotals(transactions, 'qbo')
    expect(totals.get('USDC')!.amount.toFixed(2)).toBe('762.85')
    expect(totals.get('BTC')!.amount.toFixed(2)).toBe('0.50')
  })
})
