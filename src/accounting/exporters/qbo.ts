import { TransactionType } from '@prisma/client'
import { CsvValue } from '../../utils/csv'

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
  INTERNAL_TRANSFER: 'Transfer',
}

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
export function toQbo(
  transactions: Array<{
    type: TransactionType
    amount: string
    assetSymbol: string
    fee?: string | null
    createdAt: Date
    protocolName?: string | null
  }>
): string {
  const qboTransactions: QboTransaction[] = transactions.map((tx) => {
    const category =
      TRANSACTION_TYPE_TO_QBO_CATEGORY[tx.type] || 'Uncategorized'
    const amount = Number(tx.amount)
    const fee = tx.fee ? Number(tx.fee) : 0

    let description = `${tx.type}`
    if (tx.protocolName) {
      description += ` - ${tx.protocolName}`
    }

    return {
      date: tx.createdAt.toISOString().split('T')[0],
      description,
      amount: amount.toFixed(2),
      category,
      asset: tx.assetSymbol,
      fee: fee.toFixed(2),
    }
  })

  const headers = ['Date', 'Description', 'Amount', 'Category', 'Asset', 'Fee']
  const rows = qboTransactions.map((tx) => [
    tx.date,
    tx.description,
    tx.amount,
    tx.category,
    tx.asset,
    tx.fee,
  ])

  return [headers.join(','), ...rows.map((row) => row.join(','))].join('\n')
}
