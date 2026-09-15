/**
 * Per-channel digest rendering (#365).
 *
 * `renderDigest` maps the channel-agnostic `DigestModel` onto a concrete channel.
 * Today only WHATSAPP and WEBHOOK have working delivery paths in this repo.
 * TELEGRAM and EMAIL are reserved for their sibling channel issues; calling
 * their renderers here surfaces a clear, actionable error instead of silently
 * producing nothing.
 */

import type { DigestModel } from './digest'

export type DigestRenderChannel = 'WHATSAPP' | 'TELEGRAM' | 'EMAIL' | 'WEBHOOK'

const FREQUENCY_LABEL: Record<string, string> = {
  DAILY: 'Daily',
  WEEKLY: 'Weekly',
  MONTHLY: 'Monthly',
}

function money(n: number | null, symbol = '$'): string {
  if (n === null) return 'n/a'
  return `${symbol}${n.toFixed(2)}`
}

function percent(n: number | null): string {
  if (n === null) return 'n/a'
  return `${n.toFixed(2)}%`
}

/**
 * Concise WhatsApp/Telegram-style text rendering of a digest. Kept deliberately
 * short so it fits chat-message length limits; capped lists say "+N more".
 */
function renderTextDigest(model: DigestModel): string {
  const lines: string[] = []
  lines.push(`📊 *${FREQUENCY_LABEL[model.frequency] ?? 'Portfolio'} Digest*`)

  if (!model.hasPositions) {
    lines.push('No active positions yet — deposit to get started.')
    lines.push(model.risk.text)
    return lines.join('\n')
  }

  const vc = model.valueChange
  if (
    vc.insufficientData ||
    vc.absoluteChange === null ||
    vc.percentChange === null
  ) {
    lines.push(
      `Portfolio value: *${money(vc.endValue)}* (change n/a — insufficient data)`
    )
  } else {
    const direction = vc.absoluteChange >= 0 ? '▲' : '▼'
    lines.push(
      `Portfolio value: *${money(vc.endValue)}* (${direction} ${money(
        Math.abs(vc.absoluteChange)
      )}, ${percent(vc.percentChange)})`
    )
  }

  const y = model.yield
  if (y.earned !== null) {
    lines.push(`Yield this period: *${money(y.earned)}*`)
  }
  if (y.blendedApy !== null) {
    lines.push(`Blended APY: *${percent(y.blendedApy)}*`)
  }
  if (y.best) {
    lines.push(
      `Best: ${y.best.protocolName} ${y.best.assetSymbol} (${y.best.apy !== null ? percent(y.best.apy) : 'n/a'})`
    )
  }

  const rb = model.rebalances
  if (rb.count > 0) {
    lines.push(
      `Agent rebalances: *${rb.count}*${rb.netImprovementPct !== null ? ` (avg +${percent(rb.netImprovementPct)})` : ''}`
    )
  }

  if (model.goals.length > 0) {
    const g = model.goals[0]!
    const delta =
      g.progressDeltaPct === null
        ? ''
        : ` (${g.progressDeltaPct >= 0 ? '+' : ''}${g.progressDeltaPct.toFixed(1)}pp)`
    lines.push(
      `🎯 ${g.name}: ${g.progressPctNow === null ? 'n/a' : g.progressPctNow.toFixed(0) + '%'}/${money(
        g.targetAmount
      )}${delta}${g.onTrack ? ' · on track' : ''}`
    )
  }

  lines.push(model.risk.text)

  if (model.notableTransactions.length > 0) {
    const txLines = model.notableTransactions.map((t) => {
      const direction = t.type.toUpperCase() === 'WITHDRAWAL' ? '⬅' : '➡'
      return `${direction} ${money(t.amount)} ${t.assetSymbol} (${t.type.toLowerCase()})`
    })
    lines.push(`Notable transactions:`)
    lines.push(txLines.join('\n'))
    if (model.capReached) {
      lines.push(`_+${model.notableTransactions.length} shown_`)
    }
  }

  if (model.caveats.length > 0) {
    lines.push(`ℹ️ ${model.caveats.join(' ')}`)
  }

  return lines.join('\n')
}

/**
 * Render a digest for a given channel. Returns `null` when a channel is
 * configured but currently has no delivery path (skipped with a
 * `channel_unavailable` note, never an error — see docs/NOTIFICATIONS.md).
 */
export function renderDigest(
  model: DigestModel,
  channel: DigestRenderChannel
): string | null {
  switch (channel) {
    case 'WHATSAPP':
      return renderTextDigest(model)
    case 'TELEGRAM':
      return renderTextDigest(model)
    case 'EMAIL':
      // Richer HTML/plain email rendering lands with the email-channel issue.
      return null
    case 'WEBHOOK':
      // Webhook delivery carries the structured DigestModel JSON verbatim; no
      // text projection is needed. The caller sends model as the payload.
      return null
    default:
      return null
  }
}

/** True when the channel has a working text/push delivery path today. */
export function isChannelDeliverable(channel: DigestRenderChannel): boolean {
  return channel === 'WHATSAPP' || channel === 'WEBHOOK'
}
