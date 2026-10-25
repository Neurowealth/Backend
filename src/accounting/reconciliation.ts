import crypto from 'node:crypto'
import { Decimal } from '@prisma/client/runtime/library'
import {
  AccountingExportTransaction,
  feeAmount,
  signedAmount,
} from './exporters/common'
import { QBO_HEADERS } from './exporters/qbo'
import { XERO_HEADERS } from './exporters/xeroCsv'

export type AccountingExportFormat = 'qbo' | 'xero-csv'

export interface AssetReconciliation {
  asset: string
  exportedAmount: string
  ledgerAmount: string
  diff: string
  exportedFee?: string
  ledgerFee?: string
  feeDiff?: string
  exportedRows: number
  ledgerRows: number
}

export interface AccountingReconciliation {
  reconciled: boolean
  rowCount: number
  checksum: string
  totals: AssetReconciliation[]
  diffs: string[]
}

export class AccountingReconciliationError extends Error {
  readonly format: AccountingExportFormat
  readonly reconciliation: AccountingReconciliation

  constructor(
    format: AccountingExportFormat,
    reconciliation: AccountingReconciliation
  ) {
    super(
      `Accounting export reconciliation failed: ${reconciliation.diffs.join(
        '; '
      )}`
    )
    this.name = 'AccountingReconciliationError'
    this.format = format
    this.reconciliation = reconciliation
  }
}

export interface LedgerAssetTotal {
  amount: Decimal
  fee: Decimal
  rows: number
  exportedAmount: Decimal
  exportedFee: Decimal
  exportedRows: number
}

const ZERO = new Decimal(0)

function money(value: Decimal): string {
  return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2)
}

function addTo(
  map: Map<string, LedgerAssetTotal>,
  asset: string
): LedgerAssetTotal {
  const existing = map.get(asset)
  if (existing) return existing
  const created: LedgerAssetTotal = {
    amount: ZERO,
    fee: ZERO,
    rows: 0,
    exportedAmount: ZERO,
    exportedFee: ZERO,
    exportedRows: 0,
  }
  map.set(asset, created)
  return created
}

/**
 * Compute the totals an export must reproduce, using the same per-row
 * rounding the CSV writers apply. This is deliberately derived from the
 * ledger rows, not from the generated text, so a dropped/duplicated row or a
 * formatting/sign bug cannot masquerade as a reconciled export.
 */
export function computeLedgerTotals(
  transactions: AccountingExportTransaction[],
  format: AccountingExportFormat
): Map<string, LedgerAssetTotal> {
  const totals = new Map<string, LedgerAssetTotal>()

  for (const tx of transactions) {
    const bucket = addTo(totals, tx.assetSymbol)
    const signed = signedAmount(tx.type, tx.amount)
    const fee = new Decimal(
      feeAmount(tx.fee).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    )
    // QBO writes the rounded gross amount next to the fee; Xero writes the
    // rounded net amount. Round in the same order as the writer, otherwise a
    // sub-cent fee can make a perfectly good export fail reconciliation.
    const amount =
      format === 'xero-csv'
        ? signed
            .minus(feeAmount(tx.fee))
            .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
        : signed.toDecimalPlaces(2, Decimal.ROUND_HALF_UP)

    bucket.amount = bucket.amount.plus(amount)
    bucket.fee = bucket.fee.plus(fee)
    bucket.rows += 1
  }

  return totals
}

/** RFC 4180 parser — quoted fields, escaped quotes, CRLF and LF. */
export function parseCsv(content: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < content.length; i++) {
    const char = content[i]

    if (inQuotes) {
      if (char === '"') {
        if (content[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += char
      }
      continue
    }

    if (char === '"') {
      inQuotes = true
    } else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n') {
      row.push(field.endsWith('\r') ? field.slice(0, -1) : field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += char
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }

  return rows.filter((cells) => cells.some((cell) => cell.length > 0))
}

function headerFor(format: AccountingExportFormat): string[] {
  return format === 'qbo' ? QBO_HEADERS : XERO_HEADERS
}

function diffFor(
  asset: string,
  exported: Decimal,
  ledger: Decimal,
  label: string
): string {
  const diff = exported.minus(ledger)
  return `${asset} ${label}: exported ${money(exported)} vs ledger ${money(
    ledger
  )} (diff ${diff.toFixed(2)})`
}

/**
 * Parse the generated file back and compare it with the ledger totals.
 * Throws AccountingReconciliationError with a human-readable diff when any
 * row count, amount, or fee differs.
 */
export function reconcileAccountingExport(
  format: AccountingExportFormat,
  content: string,
  transactions: AccountingExportTransaction[]
): AccountingReconciliation {
  const parsed = parseCsv(content)
  const expectedHeaders = headerFor(format)
  const diffs: string[] = []

  if (parsed.length === 0) {
    diffs.push('export is empty (missing header row)')
  } else if (JSON.stringify(parsed[0]) !== JSON.stringify(expectedHeaders)) {
    diffs.push(
      `header mismatch: expected ${expectedHeaders.join(',')}, got ${parsed[0]!.join(',')}`
    )
  }

  const dataRows = parsed.slice(1)
  const ledger = computeLedgerTotals(transactions, format)
  const expectedRows = transactions.length

  for (const cells of dataRows) {
    if (format === 'qbo') {
      if (cells.length !== QBO_HEADERS.length) {
        diffs.push(
          `malformed QBO row: expected ${QBO_HEADERS.length} columns, got ${cells.length}`
        )
        continue
      }
      const asset = cells[4] ?? ''
      const bucket = addTo(ledger, asset)
      bucket.exportedAmount = bucket.exportedAmount.plus(
        new Decimal(cells[2] || '0')
      )
      bucket.exportedFee = bucket.exportedFee.plus(new Decimal(cells[5] || '0'))
      bucket.exportedRows += 1
    } else {
      if (cells.length !== XERO_HEADERS.length) {
        diffs.push(
          `malformed Xero row: expected ${XERO_HEADERS.length} columns, got ${cells.length}`
        )
        continue
      }
      const asset = cells[4] ?? ''
      const bucket = addTo(ledger, asset)
      bucket.exportedAmount = bucket.exportedAmount.plus(
        new Decimal(cells[1] || '0')
      )
      bucket.exportedRows += 1
    }
  }

  if (dataRows.length !== expectedRows) {
    diffs.push(
      `row count: exported ${dataRows.length} vs ledger ${expectedRows}`
    )
  }

  const totals: AssetReconciliation[] = []
  const assets = [...ledger.keys()].sort()

  for (const asset of assets) {
    const bucket = ledger.get(asset)!
    const entry: AssetReconciliation = {
      asset,
      exportedAmount: money(bucket.exportedAmount),
      ledgerAmount: money(bucket.amount),
      diff: bucket.exportedAmount.minus(bucket.amount).toFixed(2),
      exportedRows: bucket.exportedRows,
      ledgerRows: bucket.rows,
    }

    if (!bucket.exportedAmount.equals(bucket.amount)) {
      diffs.push(diffFor(asset, bucket.exportedAmount, bucket.amount, 'amount'))
    }
    if (bucket.exportedRows !== bucket.rows) {
      diffs.push(
        `${asset} row count: exported ${bucket.exportedRows} vs ledger ${bucket.rows}`
      )
    }

    if (format === 'qbo') {
      entry.exportedFee = money(bucket.exportedFee)
      entry.ledgerFee = money(bucket.fee)
      entry.feeDiff = bucket.exportedFee.minus(bucket.fee).toFixed(2)
      if (!bucket.exportedFee.equals(bucket.fee)) {
        diffs.push(diffFor(asset, bucket.exportedFee, bucket.fee, 'fee'))
      }
    }

    totals.push(entry)
  }

  return {
    reconciled: diffs.length === 0,
    rowCount: dataRows.length,
    checksum: crypto.createHash('sha256').update(content, 'utf8').digest('hex'),
    totals,
    diffs,
  }
}

export function assertReconciled(
  format: AccountingExportFormat,
  content: string,
  transactions: AccountingExportTransaction[]
): AccountingReconciliation {
  const reconciliation = reconcileAccountingExport(
    format,
    content,
    transactions
  )
  if (!reconciliation.reconciled) {
    throw new AccountingReconciliationError(format, reconciliation)
  }
  return reconciliation
}
