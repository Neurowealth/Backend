import { TransactionType } from '@prisma/client'
import {
  AccountingExportTransaction,
  csvDocument,
  descriptionFor,
  feeAmount,
  signedAmount,
} from './common'

/**
 * Transaction type to accounting category mapping for QuickBooks Online.
 * Users can re-map categories in their own accounting software if needed.
 */
const TRANSACTION_TYPE_TO_QBO_CATEGORY: Record<TransactionType, string> = {
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

export const QBO_HEADERS = [
  'Date',
  'Description',
  'Amount',
  'Category',
  'Asset',
  'Fee',
]

export interface QboTransaction {
  date: string
  description: string
  amount: string
  category: string
  asset: string
  fee: string
}

/**
 * Convert transactions to QuickBooks Online-compatible QBO format.
 * This is a simplified OFX-style format that QBO can import.
 */
export function toQbo(transactions: AccountingExportTransaction[]): string {
  const qboTransactions: QboTransaction[] = transactions.map((tx) => {
    const category =
      TRANSACTION_TYPE_TO_QBO_CATEGORY[tx.type] || 'Uncategorized'
    const amount = signedAmount(tx.type, tx.amount)
    const fee = feeAmount(tx.fee)

    return {
      date: tx.createdAt.toISOString().split('T')[0]!,
      description: descriptionFor(tx),
      amount: amount.toFixed(2),
      category,
      asset: tx.assetSymbol,
      fee: fee.toFixed(2),
    }
  })

  const rows = qboTransactions.map((tx) => [
    tx.date,
    tx.description,
    tx.amount,
    tx.category,
    tx.asset,
    tx.fee,
  ])

  return csvDocument(QBO_HEADERS, rows)
}
