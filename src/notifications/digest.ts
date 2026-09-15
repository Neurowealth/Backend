/**
 * Pure digest assembler (#365).
 *
 * `buildDigest` is a **pure, deterministic** function: give it the raw portfolio
 * inputs for a period and it returns a channel-agnostic `DigestModel`. It never
 * touches the database or the clock — the scheduled job (`src/jobs/digests.ts`)
 * is responsible for fetching the data and passing it in, and callers (like the
 * `preview` endpoint) can reuse the same pure function with their own inputs.
 *
 * Honesty constraint: a period with insufficient `YieldSnapshot`s reports a
 * caveat instead of a misleading number (same discipline as the analytics
 * `caveats`). No positions yields a short "no active positions" digest, never a
 * broken message.
 */

export type DigestFrequency = 'DAILY' | 'WEEKLY' | 'MONTHLY'

export interface DigestPeriod {
  /** Human label, e.g. "Past 7 days". */
  label: string
  /** Start of the period (inclusive). */
  startAt: Date
  /** End of the period (inclusive). */
  endAt: Date
}

export interface DigestPositionInput {
  id: string
  protocolName: string
  assetSymbol: string
  currentValue: number
  /** Value the user deposited into this position. */
  depositedAmount: number
  yieldEarned: number
}

export interface DigestSnapshotInput {
  positionId: string
  /** Value (principal + accrued yield) at the snapshot instant. */
  value: number
  apy: number
  timestampMs: number
}

export interface DigestTransactionInput {
  /** DEPOSIT | WITHDRAWAL | ... — anything with a meaningful amount. */
  type: string
  amount: number
  assetSymbol: string
  createdAt: Date
}

/** One rebalance the agent executed that touched this user during the period. */
export interface DigestRebalanceInput {
  fromProtocol: string
  toProtocol: string | null
  improvedByPercent: number | null
  createdAt: Date
}

/** Latest goal state plus the state at the start of the period. */
export interface DigestGoalInput {
  name?: string | null
  targetAmount: number
  /** Progress percentage at the *start* of the period. */
  progressPctStart: number | null
  /** Progress percentage now. */
  progressPctNow: number | null
  onTrack: boolean
  currentAmount: number
}

export interface DigestInput {
  period: DigestPeriod
  positions: DigestPositionInput[]
  snapshots: DigestSnapshotInput[]
  transactions: DigestTransactionInput[]
  rebalances: DigestRebalanceInput[]
  goals: DigestGoalInput[]
  /** Fees/notes surfaced verbatim so the digest stays honest. */
  caveats: string[]
  /** Threshold above which a transaction is "notable" in the digest. */
  notableTxnThreshold: number
}

// ── Output model ──────────────────────────────────────────────────────────────

export interface DigestValueChange {
  startValue: number | null
  endValue: number
  absoluteChange: number | null
  percentChange: number | null
  /** True when snapshots were too sparse to trust the delta. */
  insufficientData: boolean
}

export interface DigestPositionSummary {
  protocolName: string
  assetSymbol: string
  value: number
  apy: number | null
}

export interface DigestYieldSummary {
  /** Yield earned during the period, when measurable. */
  earned: number | null
  /** Blended APY across active positions, when measurable. */
  blendedApy: number | null
  best: DigestPositionSummary | null
  worst: DigestPositionSummary | null
}

export interface DigestRebalanceSummary {
  count: number
  /** Net estimated improvement (in percentage points) from executed rebalances. */
  netImprovementPct: number | null
  /** Most recent rebalance, oldest last. */
  recent: DigestRebalanceInput[]
}

export interface DigestGoalSummary {
  name: string
  /** Percentage-point movement over the period. */
  progressDeltaPct: number | null
  progressPctNow: number | null
  targetAmount: number
  onTrack: boolean
}

export interface DigestRiskLine {
  /** e.g. "Max drawdown 3.2% over the period" or "Volatility steady". */
  text: string
}

export interface DigestNotableTransaction {
  type: string
  amount: number
  assetSymbol: string
  createdAt: Date
}

export interface DigestModel {
  frequency: DigestFrequency
  period: DigestPeriod
  valueChange: DigestValueChange
  yield: DigestYieldSummary
  rebalances: DigestRebalanceSummary
  goals: DigestGoalSummary[]
  /** Exactly one risk line, always populated. */
  risk: DigestRiskLine
  notableTransactions: DigestNotableTransaction[]
  /** Ordered most recent last; capped at `maxEntries`. */
  capReached: boolean
  maxEntries: number
  caveats: string[]
  /** True when the user has no active positions (empty-digest case). */
  hasPositions: boolean
}

const DEFAULT_MAX_ENTRIES = 10

function round(n: number | null, digits = 2): number | null {
  if (n === null || !Number.isFinite(n)) return null
  return Number(n.toFixed(digits))
}

/** Percent a position's earned yield represents of its current value ('now'). */
function positionApy(p: DigestPositionInput, nowValue: number): number {
  if (nowValue <= 0) return 0
  return (p.yieldEarned / nowValue) * 100
}

/**
 * Reconstruct a portfolio value from snapshots at a reference time: the value of
 * the latest snapshot on or before `beforeMs`, aggregating across positions so
 * the result is a whole-portfolio value at that instant. Returns null when no
 * snapshot fell on or before the reference time.
 */
function valueAtOrBefore(
  snapshots: DigestSnapshotInput[],
  beforeMs: number
): number | null {
  let latest: DigestSnapshotInput | null = null
  for (const s of snapshots) {
    if (s.timestampMs > beforeMs) continue
    if (!latest || s.timestampMs > latest.timestampMs) latest = s
  }
  if (!latest) return null
  // Sum all snapshots that share the latest instant (whole-portfolio value).
  let total = 0
  for (const s of snapshots) {
    if (s.timestampMs === latest.timestampMs) total += s.value
  }
  return round(total)
}

/**
 * Yield earned *during* the period: the latest snapshot's cumulative
 * principal+yield minus the snapshot closest to (on or before) the period
 * start, summed across positions. Only measured when both endpoints exist for
 * at least one position; otherwise the period is reported as insufficient.
 */
function measurePeriodYield(
  snapshots: DigestSnapshotInput[],
  period: DigestPeriod
): { earned: number | null; insufficient: boolean } {
  if (snapshots.length === 0) return { earned: null, insufficient: true }

  const startMs = period.startAt.getTime()
  const endMs = period.endAt.getTime()

  let total = 0
  let measurable = true

  // Group by position, then find the boundary snapshots per position.
  const byPosition = new Map<string, DigestSnapshotInput[]>()
  for (const s of snapshots) {
    if (s.timestampMs > endMs) continue
    const list = byPosition.get(s.positionId) ?? []
    list.push(s)
    byPosition.set(s.positionId, list)
  }

  for (const list of byPosition.values()) {
    const sorted = [...list].sort((a, b) => a.timestampMs - b.timestampMs)
    // Latest value in the period.
    const latest = sorted[sorted.length - 1]!
    // Boundary snapshot at or before the period start.
    let boundary: DigestSnapshotInput | null = null
    for (const s of sorted) {
      if (s.timestampMs <= startMs) boundary = s
    }
    // A position created within the period: treat its first snapshot as baseline.
    if (!boundary) boundary = sorted[0]
    if (!boundary) {
      measurable = false
      continue
    }
    total += latest.value - boundary.value
  }

  if (!measurable) return { earned: null, insufficient: true }
  return { earned: round(total), insufficient: false }
}

function blendedApy(positions: DigestPositionInput[]): number | null {
  const active = positions.filter((p) => p.currentValue > 0)
  if (active.length === 0) return null
  const totalValue = active.reduce((sum, p) => sum + p.currentValue, 0)
  if (totalValue <= 0) return null
  const weighted = active.reduce(
    (sum, p) =>
      sum + (p.currentValue / totalValue) * positionApy(p, p.currentValue),
    0
  )
  return round(weighted)
}

function buildRiskLine(
  snapshots: DigestSnapshotInput[],
  period: DigestPeriod,
  hasPositions: boolean
): DigestRiskLine {
  if (!hasPositions) {
    return { text: 'No active positions yet — deposit to get started.' }
  }
  const startMs = period.startAt.getTime()
  const endMs = period.endAt.getTime()
  const inPeriod = snapshots.filter(
    (s) => s.timestampMs >= startMs && s.timestampMs <= endMs
  )
  if (inPeriod.length < 2) {
    return { text: 'Insufficient snapshot history to compute a risk line.' }
  }
  // Aggregate values per instant (whole portfolio), then measure drawdown.
  const byInstant = new Map<number, number>()
  for (const s of inPeriod) {
    byInstant.set(s.timestampMs, (byInstant.get(s.timestampMs) ?? 0) + s.value)
  }
  const points = Array.from(byInstant, ([timestampMs, value]) => ({
    timestampMs,
    value,
  })).sort((a, b) => a.timestampMs - b.timestampMs)

  let peak = points[0]!.value
  let maxDrawdown = 0
  for (let i = 1; i < points.length; i++) {
    const v = points[i]!.value
    if (v > peak) peak = v
    const dd = peak > 0 ? (peak - v) / peak : 0
    if (dd > maxDrawdown) maxDrawdown = dd
  }

  if (maxDrawdown < 0.005) {
    return {
      text: `${period.label}: portfolio volatility steady (no meaningful drawdown).`,
    }
  }
  return {
    text: `${period.label}: max drawdown of ${(maxDrawdown * 100).toFixed(1)}% from peak.`,
  }
}

/**
 * Assemble a channel-agnostic portfolio digest from raw period inputs.
 * Pure and deterministic — no I/O. Throws only on programmer error (missing
 * required fields), never on data quality (that is surfaced via `caveats`).
 */
export function buildDigest(
  input: DigestInput,
  frequency: DigestFrequency = 'WEEKLY',
  maxEntries: number = DEFAULT_MAX_ENTRIES
): DigestModel {
  const positions = input.positions
  const hasPositions = positions.length > 0

  const endValue =
    round(positions.reduce((sum, p) => sum + p.currentValue, 0)) ?? 0

  const startValue = valueAtOrBefore(
    input.snapshots,
    input.period.startAt.getTime()
  )

  // Determine data sufficiency from snapshot coverage near the period start.
  const startMs = input.period.startAt.getTime()
  const hasStartSnapshot = input.snapshots.some((s) => s.timestampMs <= startMs)
  const insufficientData = input.snapshots.length === 0 || !hasStartSnapshot

  const valueChange: DigestValueChange = {
    startValue,
    endValue,
    absoluteChange: insufficientData
      ? null
      : round(startValue === null ? null : endValue - startValue),
    percentChange:
      insufficientData || startValue === null || startValue <= 0
        ? null
        : round(((endValue - startValue) / startValue) * 100),
    insufficientData,
  }

  const { earned, insufficient: yieldInsufficient } = measurePeriodYield(
    input.snapshots,
    input.period
  )

  const withApy = positions
    .filter((p) => p.currentValue > 0)
    .map((p) => ({
      protocolName: p.protocolName,
      assetSymbol: p.assetSymbol,
      value: round(p.currentValue) ?? 0,
      apy: round(positionApy(p, p.currentValue)),
    }))
    .sort((a, b) => b.value - a.value)

  const yieldSummary: DigestYieldSummary = {
    earned: yieldInsufficient ? null : earned,
    blendedApy: withApy.length ? blendedApy(positions) : null,
    best: withApy[0] ?? null,
    worst: withApy.length ? (withApy[withApy.length - 1] ?? null) : null,
  }

  const sortedRebalances = [...input.rebalances].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
  )
  const executed = sortedRebalances.filter((r) => r.toProtocol !== null)
  const improvedBy = executed
    .map((r) => r.improvedByPercent)
    .filter((v): v is number => v !== null && Number.isFinite(v))
  const rebalancesSummary: DigestRebalanceSummary = {
    count: executed.length,
    netImprovementPct:
      improvedBy.length === 0
        ? null
        : round(improvedBy.reduce((sum, v) => sum + v, 0) / improvedBy.length),
    recent: sortedRebalances.slice(-3).reverse(),
  }

  const goals: DigestGoalSummary[] = input.goals.map((g) => ({
    name: g.name || 'Savings goal',
    progressDeltaPct:
      g.progressPctNow === null || g.progressPctStart === null
        ? null
        : round(g.progressPctNow - g.progressPctStart),
    progressPctNow: round(g.progressPctNow),
    targetAmount: g.targetAmount,
    onTrack: g.onTrack,
  }))

  const notableTransactions = input.transactions
    .filter((t) => t.amount >= input.notableTxnThreshold)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .slice(-maxEntries)

  const caveats = [...input.caveats]
  if (insufficientData) {
    caveats.push(
      'Insufficient snapshot history for the start of the period; value change is not shown.'
    )
  } else if (valueChange.startValue === null) {
    caveats.push('Start-of-period value could not be reconstructed.')
  }
  if (yieldInsufficient) {
    caveats.push(
      'Insufficient snapshot coverage to measure yield earned this period.'
    )
  }

  return {
    frequency,
    period: input.period,
    valueChange,
    yield: yieldSummary,
    rebalances: rebalancesSummary,
    goals,
    risk: buildRiskLine(input.snapshots, input.period, hasPositions),
    notableTransactions,
    capReached: notableTransactions.length < input.transactions.length,
    maxEntries,
    caveats: [...new Set(caveats)],
    hasPositions,
  }
}
