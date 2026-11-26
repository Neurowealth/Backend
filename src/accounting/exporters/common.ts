import { TransactionType } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import { toCsv, CsvValue } from '../../utils/csv'

/**
 * Shared sign convention for accounting exports.
 *
 * Transaction.amount is always stored as a positive magnitude. Accounting
 * software, however, needs direction: inflows add to the account, outflows
 * subtract from it. Rebalances and swaps are internal protocol moves, not
 * external cash movements, so they export as zero-valued transfer rows rather
 * than inflating either side of the reconciliation.
 */
const INFLOW_TYPES = new Set<TransactionType>([
  TransactionType.DEPOSIT,
  TransactionType.YIELD_CLAIM,
  TransactionType.REFERRAL_REWARD,
  TransactionType.INBOUND_TRANSFER,
  TransactionType.CLAIMABLE_BALANCE_CLAIM,
  TransactionType.LOAN_DISBURSE,
])

const OUTFLOW_TYPES = new Set<TransactionType>([
  TransactionType.WITHDRAWAL,
  TransactionType.LOAN_REPAYMENT,
  TransactionType.LOAN_LIQUIDATION,
])

export interface AccountingExportTransaction {
  type: TransactionType
  amount: string | Decimal | number
  assetSymbol: string
  fee?: string | Decimal | number | null
  createdAt: Date
  protocolName?: string | null
}

export function signedAmount(
  type: TransactionType,
  amount: string | Decimal | number
): Decimal {
  const magnitude = new Decimal(amount.toString())
  if (INFLOW_TYPES.has(type)) return magnitude
  if (OUTFLOW_TYPES.has(type)) return magnitude.negated()
  return new Decimal(0)
}

export function feeAmount(
  fee: string | Decimal | number | null | undefined
): Decimal {
  return fee === null || fee === undefined
    ? new Decimal(0)
    : new Decimal(fee.toString())
}

export function csvDocument(headers: string[], rows: CsvValue[][]): string {
  return toCsv(headers, rows)
}

export function descriptionFor(tx: AccountingExportTransaction): string {
  return tx.protocolName ? `${tx.type} - ${tx.protocolName}` : `${tx.type}`
}
