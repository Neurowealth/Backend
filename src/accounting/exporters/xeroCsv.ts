import { TransactionType } from '@prisma/client'

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
  INTERNAL_TRANSFER: 'Transfer',
}

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
 */
export function toXeroCsv(
  transactions: Array<{
    type: TransactionType
    amount: string
    assetSymbol: string
    fee?: string | null
    createdAt: Date
    protocolName?: string | null
  }>
): string {
  const xeroTransactions: XeroTransaction[] = transactions.map((tx) => {
    const category =
      TRANSACTION_TYPE_TO_XERO_CATEGORY[tx.type] || 'Uncategorized'
    const amount = Number(tx.amount)
    const fee = tx.fee ? Number(tx.fee) : 0
    const netAmount = amount - fee

    let description = `${tx.type}`
    if (tx.protocolName) {
      description += ` - ${tx.protocolName}`
    }

    return {
      date: tx.createdAt.toISOString().split('T')[0],
      amount: netAmount.toFixed(2),
      payee: 'NeuroWealth',
      description,
      reference: tx.assetSymbol,
      category,
    }
  })

  const headers = [
    'Date',
    'Amount',
    'Payee',
    'Description',
    'Reference',
    'Category',
  ]
  const rows = xeroTransactions.map((tx) => [
    tx.date,
    tx.amount,
    tx.payee,
    tx.description,
    tx.reference,
    tx.category,
  ])

  return [headers.join(','), ...rows.map((row) => row.join(','))].join('\n')
}
