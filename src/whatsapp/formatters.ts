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

export function formatGoalProgressReply(input: {
  status: string
  targetAmount: number
  currentAmount: number
  targetDate: string
  requiredApy: number
  actualApy: number
  onTrack: boolean
  reachable: boolean
  projectedCompletionDate: string | null
}): string {
  if (input.status === 'ACHIEVED') {
    return [
      '🎯 *Savings Goal*',
      `You've reached your goal of $${input.targetAmount.toFixed(2)}! 🎉`,
    ].join('\n')
  }

  if (input.status === 'MISSED') {
    return [
      '🎯 *Savings Goal*',
      `Target date passed at $${input.currentAmount.toFixed(2)} of $${input.targetAmount.toFixed(2)}.`,
    ].join('\n')
  }

  if (input.status === 'CANCELLED') {
    return ['🎯 *Savings Goal*', 'This goal has been cancelled.'].join('\n')
  }

  const lines = [
    '🎯 *Savings Goal Progress*',
    `Progress: *$${input.currentAmount.toFixed(2)}* of *$${input.targetAmount.toFixed(2)}*`,
    `Target date: _${input.targetDate.slice(0, 10)}_`,
    `Required APY: *${input.requiredApy.toFixed(2)}%* | Actual APY: *${input.actualApy.toFixed(2)}%*`,
  ]

  if (!input.reachable) {
    lines.push('⚠️ Target not reachable within your risk tolerance.')
  } else if (input.onTrack) {
    lines.push('✅ On track to reach your goal.')
  } else {
    lines.push('⏳ Behind schedule, but still reachable.')
  }

  if (input.projectedCompletionDate) {
    lines.push(
      `Projected completion: _${input.projectedCompletionDate.slice(0, 10)}_`
    )
  }

  return lines.join('\n')
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

const ALERT_METRIC_LABELS: Record<string, string> = {
  PROTOCOL_APY: 'Protocol APY',
  PORTFOLIO_VALUE: 'Portfolio value',
  POSITION_DRAWDOWN: 'Position drawdown',
}

const ALERT_COMPARATOR_LABELS: Record<string, string> = {
  LT: 'below',
  LTE: 'at or below',
  GT: 'above',
  GTE: 'at or above',
}

/**
 * WhatsApp message sent when a user's alert rule fires (#289). Units follow the
 * rule's metric: APY and drawdown are percentages, portfolio value is USD.
 */
export function formatAlertTriggeredReply(input: {
  metric: string
  protocolName?: string | null
  comparator: string
  threshold: number
  observedValue: number
}): string {
  const metricLabel = ALERT_METRIC_LABELS[input.metric] ?? input.metric
  const comparatorLabel =
    ALERT_COMPARATOR_LABELS[input.comparator] ?? input.comparator
  const isPercent =
    input.metric === 'PROTOCOL_APY' || input.metric === 'POSITION_DRAWDOWN'
  const unit = isPercent ? '%' : ''
  const prefix = isPercent ? '' : '$'
  const subject =
    input.metric === 'PROTOCOL_APY' && input.protocolName
      ? `${metricLabel} (${input.protocolName})`
      : metricLabel

  const fmt = (n: number): string =>
    `${prefix}${n.toFixed(2)}${unit}`

  return [
    '🔔 *Alert triggered*',
    `${subject} is ${comparatorLabel} *${fmt(input.threshold)}*.`,
    `Current: *${fmt(input.observedValue)}*`,
  ].join('\n')
}

function describeAlertRule(rule: {
  metric: string
  protocolName?: string | null
  comparator: string
  threshold: number
}): string {
  const metricLabel = ALERT_METRIC_LABELS[rule.metric] ?? rule.metric
  const comparatorLabel =
    ALERT_COMPARATOR_LABELS[rule.comparator] ?? rule.comparator
  const isPercent =
    rule.metric === 'PROTOCOL_APY' || rule.metric === 'POSITION_DRAWDOWN'
  const value = isPercent
    ? `${rule.threshold}%`
    : `$${rule.threshold.toFixed(2)}`
  const subject =
    rule.metric === 'PROTOCOL_APY' && rule.protocolName
      ? `${metricLabel} (${rule.protocolName})`
      : metricLabel
  return `${subject} ${comparatorLabel} ${value}`
}

/** Confirmation shown after a user creates an alert rule over WhatsApp (#289). */
export function formatAlertCreatedReply(rule: {
  id: string
  metric: string
  protocolName?: string | null
  comparator: string
  threshold: number
}): string {
  return [
    '✅ *Alert created*',
    describeAlertRule(rule),
    `_ID: ${rule.id}_`,
  ].join('\n')
}

/** Lists a user's alert rules over WhatsApp (#289). */
export function formatAlertListReply(
  rules: Array<{
    id: string
    metric: string
    protocolName?: string | null
    comparator: string
    threshold: number
    isActive: boolean
  }>,
): string {
  if (rules.length === 0) {
    return '🔕 You have no alert rules yet. Try "alert me when Blend apy < 5".'
  }
  const lines = rules.slice(0, 10).map((rule) => {
    const state = rule.isActive ? '' : ' _(inactive)_'
    return `• ${describeAlertRule(rule)}${state}\n  _${rule.id}_`
  })
  return ['🔔 *Your alert rules*', lines.join('\n')].join('\n')
}

/** Confirmation shown after deleting an alert rule over WhatsApp (#289). */
export function formatAlertDeletedReply(found: boolean): string {
  return found
    ? '🗑️ *Alert deleted.*'
    : "I couldn't find an alert with that ID that belongs to you."
}
