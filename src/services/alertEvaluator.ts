/**
 * Alert rule evaluation core (#289).
 *
 * Pure, side-effect-free helpers so the threshold-crossing and cooldown logic
 * can be unit-tested in isolation from the scheduler and the database (see the
 * suggested implementation plan in the issue). The job in
 * src/jobs/alertRules.ts does the DB I/O and delivery; everything here is
 * deterministic given its inputs.
 */

export type AlertMetric =
  'PROTOCOL_APY' | 'PORTFOLIO_VALUE' | 'POSITION_DRAWDOWN'
export type Comparator = 'LT' | 'LTE' | 'GT' | 'GTE'

/**
 * Evaluate a comparator against an observed value and threshold.
 * Returns true when the condition the user asked to be alerted about holds.
 */
export function compare(
  comparator: Comparator,
  observed: number,
  threshold: number
): boolean {
  switch (comparator) {
    case 'LT':
      return observed < threshold
    case 'LTE':
      return observed <= threshold
    case 'GT':
      return observed > threshold
    case 'GTE':
      return observed >= threshold
    default:
      return false
  }
}

/**
 * Whether a rule is still inside its cooldown window and must NOT fire again.
 *
 * A rule that has never fired (lastFiredAt == null) is never in cooldown. The
 * window is [lastFiredAt, lastFiredAt + cooldownMinutes). Once `now` reaches or
 * passes the end of that window the rule may fire again — the condition does
 * NOT have to flip false and back to true in between (see issue edge cases).
 */
export function isCooldownActive(
  lastFiredAt: Date | null | undefined,
  cooldownMinutes: number,
  now: Date
): boolean {
  if (!lastFiredAt) return false
  const elapsedMs = now.getTime() - lastFiredAt.getTime()
  return elapsedMs < cooldownMinutes * 60_000
}

/**
 * The instant at which a rule's cooldown expires — anything with
 * lastFiredAt <= this cutoff is eligible to fire again. Used to build the
 * atomic fire-claim query in the job.
 */
export function cooldownCutoff(cooldownMinutes: number, now: Date): Date {
  return new Date(now.getTime() - cooldownMinutes * 60_000)
}

/**
 * Percentage drawdown of a current value from a peak reference.
 *
 * Drawdown is defined as the decline from the rolling peak:
 *   drawdown% = max(0, (peak - current) / peak * 100)
 *
 * Clamped at 0 so a value at or above its peak reports no drawdown rather than
 * a negative number. Returns 0 when peak <= 0 (no meaningful reference yet).
 */
export function computeDrawdownPercent(
  peakValue: number,
  currentValue: number
): number {
  if (peakValue <= 0) return 0
  const drawdown = ((peakValue - currentValue) / peakValue) * 100
  return drawdown > 0 ? drawdown : 0
}

/**
 * Reduce a set of historical portfolio-value samples plus the current value to
 * a rolling peak. The current value is included as a candidate so a brand-new
 * high is its own peak (zero drawdown), never a value below a stale sample.
 */
export function rollingPeak(
  historicalValues: number[],
  currentValue: number
): number {
  return Math.max(currentValue, ...historicalValues, 0)
}

export interface EvaluatableRule {
  metric: AlertMetric
  comparator: Comparator
  threshold: number
  cooldownMinutes: number
  lastFiredAt: Date | null
}

export interface EvaluationResult {
  /** The comparator condition holds for the observed value. */
  conditionMet: boolean
  /** The rule is eligible to fire now (condition met AND cooldown elapsed). */
  shouldFire: boolean
}

/**
 * Decide whether a rule should fire given the value observed this tick.
 * Combines the threshold check with the cooldown suppression.
 */
export function evaluateRule(
  rule: EvaluatableRule,
  observedValue: number,
  now: Date
): EvaluationResult {
  const conditionMet = compare(rule.comparator, observedValue, rule.threshold)
  const shouldFire =
    conditionMet &&
    !isCooldownActive(rule.lastFiredAt, rule.cooldownMinutes, now)
  return { conditionMet, shouldFire }
}
