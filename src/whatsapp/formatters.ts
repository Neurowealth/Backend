type PositionSummary = {
  protocolName: string
  assetSymbol: string
  currentValue: number
}

type TxSummary = {
  txHash: string | null
  type: string
  status: string
  amount: number
  assetSymbol: string
}

type ProtocolRateSummary = {
  protocolName: string
  assetSymbol: string
  supplyApy: number
}

export function formatPortfolioReply(input: {
  totalBalance: number
  totalEarnings: number
  activePositions: number
  positions: PositionSummary[]
}): string {
  const lines = input.positions.slice(0, 3).map((position) => {
    return `• ${position.protocolName} ${position.assetSymbol}: $${position.currentValue.toFixed(2)}`
  })

  return [
    '💼 *Portfolio Snapshot*',
    `Balance: *$${input.totalBalance.toFixed(2)}*`,
    `Earnings: *$${input.totalEarnings.toFixed(2)}*`,
    `Active positions: *${input.activePositions}*`,
    lines.length ? lines.join('\n') : 'No active positions yet.',
  ].join('\n')
}

export function formatPortfolioHistoryReply(input: {
  period: '7d' | '30d' | '90d'
  points: Array<{ date: string; yieldAmount: number }>
}): string {
  const lines = input.points.slice(0, 5).map((point) => {
    return `• ${point.date}: +$${point.yieldAmount.toFixed(2)}`
  })

  return [
    `📈 *History (${input.period})*`,
    lines.length ? lines.join('\n') : 'No history available for this period.',
  ].join('\n')
}

export function formatPortfolioEarningsReply(input: {
  totalEarnings: number
  averageApy: number
  periodEarnings: number
}): string {
  return [
    '🧾 *Earnings Summary*',
    `Total earned: *$${input.totalEarnings.toFixed(2)}*`,
    `30d earnings: *$${input.periodEarnings.toFixed(2)}*`,
    `Average APY: *${(input.averageApy * 100).toFixed(2)}%*`,
  ].join('\n')
}

export function formatTransactionsReply(input: {
  page: number
  limit: number
  transactions: TxSummary[]
}): string {
  const lines = input.transactions.map((tx) => {
    const hash = tx.txHash ? `${tx.txHash.slice(0, 8)}...` : 'pending'
    return `• ${tx.type} ${tx.amount} ${tx.assetSymbol} (${tx.status}) [${hash}]`
  })

  return [
    `📜 *Transactions* (page ${input.page}, showing ${input.limit})`,
    lines.length ? lines.join('\n') : 'No transactions found.',
  ].join('\n')
}

export function formatTransactionDetailReply(input: TxSummary): string {
  return [
    '🔎 *Transaction Detail*',
    `Type: *${input.type}*`,
    `Status: *${input.status}*`,
    `Amount: *${input.amount} ${input.assetSymbol}*`,
    `Hash: _${input.txHash || 'pending'}_`,
  ].join('\n')
}

export function formatProtocolRatesReply(input: {
  rates: ProtocolRateSummary[]
}): string {
  const lines = input.rates.slice(0, 5).map((rate) => {
    return `• ${rate.protocolName} ${rate.assetSymbol}: *${(rate.supplyApy * 100).toFixed(2)}% APY*`
  })

  return ['🏦 *Protocol Rates*', lines.join('\n')].join('\n')
}

export function formatAgentStatusReply(input: {
  status: string
  action: string
  updatedAt: string
}): string {
  return [
    '🤖 *Agent Status*',
    `Latest action: *${input.action}*`,
    `State: *${input.status}*`,
    `Updated: _${input.updatedAt}_`,
  ].join('\n')
}

export function formatDepositReply(input: {
  amount: number
  assetSymbol: string
  protocolName?: string | null
}): string {
  return [
    '✅ *Deposit queued*',
    `Amount: *${input.amount} ${input.assetSymbol}*`,
    `Protocol: *${input.protocolName || 'Auto'}*`,
    '_Your transaction is being processed._',
  ].join('\n')
}

export function formatWithdrawReply(input: {
  amount: number
  assetSymbol: string
  protocolName?: string | null
}): string {
  return [
    '💸 *Withdrawal queued*',
    `Amount: *${input.amount} ${input.assetSymbol}*`,
    `Protocol: *${input.protocolName || 'Auto'}*`,
    '_You will receive a confirmation once settled._',
  ].join('\n')
}
