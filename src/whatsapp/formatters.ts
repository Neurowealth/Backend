/**
 * Chat reply formatters.
 *
 * Each function is a pure formatter: it takes already-fetched data and
 * returns a single multi-line string ready to send as a chat message. No I/O
 * happens here.
 *
 * Formatting conventions used throughout:
 *  - `*text*` renders as bold and `_text_` as italic (Markdown-style chat
 *    syntax, as used by messengers such as Telegram/WhatsApp).
 *  - Each reply is built as an array of lines joined with '\n'.
 *  - Lists are capped (3-5 items) so replies stay short enough for chat.
 *  - Money is shown to 2 decimal places; APY values arrive as fractions
 *    (0.05) and are shown as percentages (5.00%). The exception is
 *    formatGoalProgressReply, which prints its APY values as given.
 */

// Minimal view of a user's position in a protocol; only what the reply needs.
type PositionSummary = {
  protocolName: string
  assetSymbol: string
  currentValue: number
}

// Minimal view of a transaction. `txHash` is null until the transaction has
// been submitted on-chain, which the formatters display as "pending".
type TxSummary = {
  txHash: string | null
  type: string
  status: string
  amount: number
  assetSymbol: string
}

// Minimal view of a protocol's current supply rate. `supplyApy` is a
// fraction (0.05 = 5%).
type ProtocolRateSummary = {
  protocolName: string
  assetSymbol: string
  supplyApy: number
}

/**
 * Portfolio snapshot: totals plus up to the first 3 positions.
 * Positions are shown in the order given, so callers should sort them
 * (e.g. by value) beforehand if they want the largest ones first.
 */
export function formatPortfolioReply(input: {
  totalBalance: number
  totalEarnings: number
  activePositions: number
  positions: PositionSummary[]
}): string {
  // Cap at 3 positions to keep the message short.
  const lines = input.positions.slice(0, 3).map((position) => {
    return `• ${position.protocolName} ${position.assetSymbol}: $${position.currentValue.toFixed(2)}`
  })

  return [
    '💼 *Portfolio Snapshot*',
    `Balance: *$${input.totalBalance.toFixed(2)}*`,
    `Earnings: *$${input.totalEarnings.toFixed(2)}*`,
    `Active positions: *${input.activePositions}*`,
    // Fall back to a friendly empty-state line when there is nothing to list.
    lines.length ? lines.join('\n') : 'No active positions yet.',
  ].join('\n')
}

/**
 * Yield history for a chosen period, showing only the first 5 data points.
 * Points are displayed in the order given, so callers decide whether that is
 * oldest-first or newest-first.
 */
export function formatPortfolioHistoryReply(input: {
  period: '7d' | '30d' | '90d'
  points: Array<{ date: string; yieldAmount: number }>
}): string {
  const lines = input.points.slice(0, 5).map((point) => {
    // The "+" prefix is hardcoded, so a negative yieldAmount would render
    // as "+$-1.23".
    return `• ${point.date}: +$${point.yieldAmount.toFixed(2)}`
  })

  return [
    `📈 *History (${input.period})*`,
    lines.length ? lines.join('\n') : 'No history available for this period.',
  ].join('\n')
}

/**
 * Earnings summary: lifetime total, recent-period total, and average APY.
 * `averageApy` is a fraction and is converted to a percentage here.
 */
export function formatPortfolioEarningsReply(input: {
  totalEarnings: number
  averageApy: number
  periodEarnings: number
}): string {
  return [
    '🧾 *Earnings Summary*',
    `Total earned: *$${input.totalEarnings.toFixed(2)}*`,
    // The label is fixed at "30d", so callers must pass 30-day earnings here.
    `30d earnings: *$${input.periodEarnings.toFixed(2)}*`,
    `Average APY: *${(input.averageApy * 100).toFixed(2)}%*`,
  ].join('\n')
}

/**
 * One page of the transaction list. The caller is expected to have already
 * paginated the data; this function only formats what it is given and does
 * not slice by `limit` (the limit is just echoed in the header).
 */
export function formatTransactionsReply(input: {
  page: number
  limit: number
  transactions: TxSummary[]
}): string {
  const lines = input.transactions.map((tx) => {
    // Show a shortened hash (first 8 chars) to keep lines compact, or
    // "pending" if the transaction has no on-chain hash yet.
    const hash = tx.txHash ? `${tx.txHash.slice(0, 8)}...` : 'pending'
    return `• ${tx.type} ${tx.amount} ${tx.assetSymbol} (${tx.status}) [${hash}]`
  })

  return [
    `📜 *Transactions* (page ${input.page}, showing ${input.limit})`,
    lines.length ? lines.join('\n') : 'No transactions found.',
  ].join('\n')
}

/**
 * Full detail for a single transaction. Unlike the list view, this shows the
 * complete hash (italicised so it is easy to spot and copy).
 */
export function formatTransactionDetailReply(input: TxSummary): string {
  return [
    '🔎 *Transaction Detail*',
    `Type: *${input.type}*`,
    `Status: *${input.status}*`,
    `Amount: *${input.amount} ${input.assetSymbol}*`,
    // `||` (not `??`) so an empty-string hash also falls back to "pending".
    `Hash: _${input.txHash || 'pending'}_`,
  ].join('\n')
}

/**
 * Current supply APYs, showing the first 5 rates. Rates are shown in the
 * order given, so callers should sort best-first if that is the intent.
 */
export function formatProtocolRatesReply(input: {
  rates: ProtocolRateSummary[]
}): string {
  const lines = input.rates.slice(0, 5).map((rate) => {
    return `• ${rate.protocolName} ${rate.assetSymbol}: *${(rate.supplyApy * 100).toFixed(2)}% APY*`
  })

  // Unlike the other list formatters, there is no empty-state message here:
  // with no rates, the reply is just the header followed by a blank line.
  return ['🏦 *Protocol Rates*', lines.join('\n')].join('\n')
}

/**
 * Latest status of the automated agent: its most recent action, its current
 * state, and when it was last updated. `updatedAt` is displayed as given, so
 * pass an already human-readable string.
 */
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

/**
 * Confirmation sent after a deposit has been accepted into the queue (not
 * yet settled on-chain). If no protocol was chosen, it is shown as "Auto",
 * meaning the system picks one.
 */
export function formatDepositReply(input: {
  amount: number
  assetSymbol: string
  protocolName?: string | null
}): string {
  return [
    '✅ *Deposit queued*',
    `Amount: *${input.amount} ${input.assetSymbol}*`,
    // Covers both undefined and null (and empty string) -> "Auto".
    `Protocol: *${input.protocolName || 'Auto'}*`,
    '_Your transaction is being processed._',
  ].join('\n')
}

/**
 * Savings-goal progress. The reply depends on the goal's status:
 *  - ACHIEVED / MISSED / CANCELLED: a short terminal message.
 *  - anything else (active): progress, target date, required vs actual APY,
 *    an on-track / behind / unreachable line, and a projected completion date
 *    when one is available.
 *
 * Dates are expected as ISO strings and are trimmed to YYYY-MM-DD. Unlike the
 * other formatters, `requiredApy` and `actualApy` are printed as given with a
 * "%" sign (no ×100 conversion), so pass them as percentages, not fractions.
 */
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
    // slice(0, 10) keeps just the date part of an ISO timestamp.
    `Target date: _${input.targetDate.slice(0, 10)}_`,
    `Required APY: *${input.requiredApy.toFixed(2)}%* | Actual APY: *${input.actualApy.toFixed(2)}%*`,
  ]

  // Exactly one status line: not reachable, on track, or behind but reachable.
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

/**
 * Confirmation sent after a withdrawal has been accepted into the queue.
 * Mirrors formatDepositReply; the closing line tells the user a follow-up
 * message will arrive once it settles.
 */
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

export function formatRecurringDepositExecuted(input: {
  amount: number
  assetSymbol: string
  cadence: string
}): string {
  return [
    '✅ *Recurring deposit executed*',
    `Amount: *${input.amount} ${input.assetSymbol}*`,
    `Schedule: *${input.cadence}*`,
    '_Your automatic deposit has been processed._',
  ].join('\n')
}

export function formatRecurringDepositFailed(input: {
  amount: number
  assetSymbol: string
  reason: string
}): string {
  return [
    '❌ *Recurring deposit failed*',
    `Amount: *${input.amount} ${input.assetSymbol}*`,
    `Reason: _${input.reason}_`,
    '_Please check your wallet balance and try again later._',
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

  const fmt = (n: number): string => `${prefix}${n.toFixed(2)}${unit}`

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
  }>
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

/**
 * Sent to a follower when a strategy they follow changes materially (#285).
 * Names the label only — never the publisher, who is anonymous to followers.
 */
export function formatStrategyUpdatedReply(input: {
  label: string
  configVersion: number
}): string {
  return [
    '🔄 *Strategy updated*',
    `A strategy you follow — _${input.label}_ — changed its configuration (v${input.configVersion}).`,
    'Your agent will apply it on its next scheduled run. Your own risk ceiling still applies.',
  ].join('\n')
}

/**
 * Sent to a follower when a strategy they follow is delisted (#285). The
 * reassurance is the point: nothing about their agent changes, so the message
 * must not read as an action item.
 */
export function formatStrategyUnpublishedReply(input: {
  label: string
}): string {
  return [
    '📴 *Strategy delisted*',
    `_${input.label}_ is no longer listed on the marketplace.`,
    'Your agent keeps running the configuration you already copied — nothing changes unless you unfollow.',
  ].join('\n')
}
