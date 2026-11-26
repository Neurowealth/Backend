import { TransactionType } from '@prisma/client'
import {
  AccountingExportTransaction,
  csvDocument,
  descriptionFor,
  feeAmount,
  signedAmount,
} from './common'

/**
 * Transaction type to accounting category mapping for Xero.
 * Xero uses specific column names for bank statement imports.
 */
const TRANSACTION_TYPE_TO_XERO_CATEGORY: Record<TransactionType, string> = {
  DEPOSIT: 'Transfer In',
  WITHDRAWAL: 'Transfer Out',
  YIELD_CLAIM: 'Interest Income',
  REBALANCE: 'Transfer',
  SWAP: 'Transfer',
  REFERRAL_REWARD: 'Other Income',
  INBOUND_TRANSFER: 'Transfer In',
  CLAIMABLE_BALANCE_CLAIM: 'Transfer In',
  LOAN_DISBURSE: 'Transfer In',
  LOAN_REPAYMENT: 'Transfer Out',
  LOAN_LIQUIDATION: 'Transfer Out',
}

export const XERO_HEADERS = [
  'Date',
  'Amount',
  'Payee',
  'Description',
  'Reference',
  'Category',
]

export interface XeroTransaction {
  date: string
  amount: string
  payee: string
  description: string
  reference: string
  category: string
}

/**
 * Convert transactions to Xero-compatible bank statement CSV format.
 * Xero expects specific column headers for bank statement imports.
 *
 * Xero's Amount column is the net movement: the signed transaction amount
 * minus the fee, so the bank statement import reconciles to the ledger.
 */
export function toXeroCsv(transactions: AccountingExportTransaction[]): string {
  const xeroTransactions: XeroTransaction[] = transactions.map((tx) => {
    const category =
      TRANSACTION_TYPE_TO_XERO_CATEGORY[tx.type] || 'Uncategorized'
    const netAmount = signedAmount(tx.type, tx.amount).minus(feeAmount(tx.fee))

    return {
      date: tx.createdAt.toISOString().split('T')[0]!,
      amount: netAmount.toFixed(2),
      payee: 'NeuroWealth',
      description: descriptionFor(tx),
      reference: tx.assetSymbol,
      category,
    }
  })

  const rows = xeroTransactions.map((tx) => [
    tx.date,
    tx.amount,
    tx.payee,
    tx.description,
    tx.reference,
    tx.category,
  ])

  return csvDocument(XERO_HEADERS, rows)
}
