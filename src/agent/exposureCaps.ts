/**
 * Per-protocol exposure caps (#346) — pure computation.
 *
 * The MaxYield rebalancer chases the single highest net-of-cost APY and can
 * concentrate a user's ENTIRE position into one protocol. This module derives a
 * hard ceiling on the FRACTION of a user's portfolio that may sit in any single
 * protocol, from their risk tolerance with per-user overrides, and provides the
 * clamping helpers the rebalance loop uses to keep every move within cap.
 *
 * Zero I/O: everything here is a function of its arguments, so the cap math —
 * the part that actually changes what the agent may do with someone's money —
 * is unit testable in isolation.
 *
 * ─── SEMANTICS ───────────────────────────────────────────────────────────────
 *
 * A cap is expressed as a FRACTION in [0, 1]. The default comes from a
 * riskTolerance → cap table; higher risk tolerance allows a larger single-
 * protocol share. Per-user overrides live in strategyConfig.exposureCaps and
 * strategyConfig.defaultMaxFraction and take precedence over the table.
 *
 * A riskCeiling violation (see applyRiskCeiling) and an exposure cap are
 * DIFFERENT controls. The ceiling decides ELIGIBILITY (which protocols may be
 * entered at all); the cap is a SIZING constraint on the eligible set. This
 * module only produces sizing constraints — eligibility stays with the strategy
 * engine.
 *
 * ─── UNPLACEABLE PORTFOLIOS ──────────────────────────────────────────────────
 *
 * When the sum of caps over the eligible protocols is < 100%, the portfolio
 * cannot be fully placed under caps. The loop must NEVER violate a cap to force
 * placement; it places what it can up to each cap and leaves the remainder in
 * the current protocol (see clampMoveToCap + the routing decision in router.ts).
 */

/**
 * Default riskTolerance → max single-protocol share table. Fraction in [0, 1].
 *
 * Tuned so that a conservative user (tolerance 1) can hold at most 25% in one
 * protocol, a moderate user (5) up to half, and the most aggressive (10) may
 * concentrate fully. These are the DEFAULTS — a user can raise or lower them
 * via strategyConfig.exposureCaps / defaultMaxFraction.
 */
export const RISK_TOLERANCE_CAP_TABLE: ReadonlyArray<{
  toleranceAtMost: number
  maxFraction: number
}> = [
  { toleranceAtMost: 1, maxFraction: 0.25 },
  { toleranceAtMost: 2, maxFraction: 0.3 },
  { toleranceAtMost: 3, maxFraction: 0.35 },
  { toleranceAtMost: 4, maxFraction: 0.4 },
  { toleranceAtMost: 5, maxFraction: 0.5 },
  { toleranceAtMost: 6, maxFraction: 0.6 },
  { toleranceAtMost: 7, maxFraction: 0.7 },
  { toleranceAtMost: 8, maxFraction: 0.8 },
  { toleranceAtMost: 9, maxFraction: 0.9 },
  { toleranceAtMost: 10, maxFraction: 1.0 },
]

/** A resolved cap for one protocol: a fraction, and optionally an absolute amount. */
export interface ExposureCap {
  /** Max fraction of the portfolio in this protocol, in [0,1]. */
  maxFraction: number
  /**
   * Optional absolute ceiling on the value held in the protocol, as a Decimal
   * string (36,18). When set, BOTH the fraction and the absolute amount bound
   * the protocol — the effective constraint is the stricter of the two.
   */
  maxAbsolute?: string
}

/** Resolved, effective cap for one protocol factoring both bounds. */
export interface EffectiveExposureCap extends ExposureCap {
  protocol: string
  /**
   * Which layer supplied the cap, for explainability: a per-protocol override,
   * the user's defaultMaxFraction, or the risk-tolerance default table.
   */
  source: 'override' | 'default' | 'tolerance'
  /** True when the override carried an absolute amount bound. */
  hasAbsolute: boolean
}

/** Raw, unvalidated user override shape lifted from strategyConfig (Json). */
export interface ExposureCapOverride {
  maxFraction?: number
  maxAbsolute?: string
}

/** The full per-user override structure stored in strategyConfig. */
export interface ExposureCapsConfig {
  perProtocol?: Record<string, ExposureCapOverride>
  defaultMaxFraction?: number
}

/** A portfolio composition snapshot for cap resolution and clamping. */
export interface ExposureSnapshot {
  /** Current fraction of the portfolio in each protocol, keyed by protocol name. */
  fractions: Record<string, number>
  /** Current absolute value in each protocol (Decimal string), when known. */
  absolute?: Record<string, string>
  /** Total portfolio value (Decimal string). */
  totalValue?: string
}

/**
 * Default cap for a risk tolerance, from the table. Out-of-range tolerances are
 * clamped to the nearest table row, so an unexpected value never yields an
 * undefined or over-permissive cap.
 */
export function defaultCapForRiskTolerance(riskTolerance: number): number {
  const base = Number.isFinite(riskTolerance) ? riskTolerance : 5
  const tol = Math.max(1, Math.min(10, Math.round(base)))
  const row = RISK_TOLERANCE_CAP_TABLE.find((r) => tol <= r.toleranceAtMost)
  return row ? row.maxFraction : 0.5
}

/**
 * Resolve the effective cap for a single protocol.
 *
 * Precedence (highest first):
 *   1. strategyConfig.exposureCaps["<protocol>"] — per-protocol override.
 *   2. strategyConfig.defaultMaxFraction — user-level default for all protocols.
 *   3. The riskTolerance default table.
 *
 * Returns the resolved maxFraction, plus an optional maxAbsolute from a
 * per-protocol override.
 */
export function resolveProtocolCap(
  protocol: string,
  riskTolerance: number,
  overrides?: ExposureCapsConfig
): EffectiveExposureCap {
  const perProtocol = overrides?.perProtocol?.[protocol]
  const defaultMaxFraction = overrides?.defaultMaxFraction

  if (perProtocol && typeof perProtocol.maxFraction === 'number') {
    return {
      protocol,
      maxFraction: clampFraction(perProtocol.maxFraction),
      maxAbsolute: perProtocol.maxAbsolute,
      source: 'override',
      hasAbsolute: typeof perProtocol.maxAbsolute === 'string',
    }
  }

  if (typeof defaultMaxFraction === 'number') {
    return {
      protocol,
      maxFraction: clampFraction(defaultMaxFraction),
      source: 'default',
      hasAbsolute: false,
    }
  }

  return {
    protocol,
    maxFraction: defaultCapForRiskTolerance(riskTolerance),
    source: 'tolerance',
    hasAbsolute: false,
  }
}

function clampFraction(v: number): number {
  if (!Number.isFinite(v)) return 0.5
  return Math.max(0, Math.min(1, v))
}

/**
 * Build the resolved cap map for a set of protocols. Deterministic: keys are
 * returned in the order given (the caller controls ordering, e.g. sorted).
 */
export function resolveExposureCap(
  protocols: string[],
  riskTolerance: number,
  overrides?: ExposureCapsConfig
): Record<string, EffectiveExposureCap> {
  const out: Record<string, EffectiveExposureCap> = {}
  for (const p of protocols)
    out[p] = resolveProtocolCap(p, riskTolerance, overrides)
  return out
}

const MAX_ABSOLUTE_EPSILON = 0

/**
 * Effective fraction bound for a protocol given both the fraction cap and an
 * optional absolute cap. Decimal-string aware when totalValue is provided.
 * Returns the stricter of the two in fraction terms.
 */
function effectiveFractionBound(
  eff: EffectiveExposureCap,
  total: number
): number {
  let bound = eff.maxFraction
  if (eff.maxAbsolute !== undefined) {
    const abs = Number(eff.maxAbsolute)
    if (Number.isFinite(abs) && total > 0) {
      const absFraction = abs / total
      if (absFraction < bound) bound = absFraction
    }
  }
  return clamped(bound)
}

function clamped(v: number): number {
  return Math.max(0, Math.min(1, v))
}

/**
 * The largest fraction of the portfolio that may be moved INTO `target`
 * protocol while staying within its cap, given a snapshot of current exposure.
 *
 * Returns 0 when the protocol is already at/over its effective cap (nothing
 * more may be routed in), and the residual headroom otherwise.
 */
export function availableFractionHeadroom(
  target: string,
  snapshot: ExposureSnapshot,
  cap: EffectiveExposureCap,
  total: number = 0
): number {
  const currentFraction = snapshot.fractions[target] ?? 0
  const effectiveBound = effectiveFractionBound(
    cap,
    total > 0 ? total : Number(snapshot.totalValue ?? 0)
  )
  const headroom = effectiveBound - currentFraction
  return headroom > MAX_ABSOLUTE_EPSILON ? headroom : 0
}

/**
 * Clamp a proposed move `moveFraction` (fraction of the portfolio being moved
 * INTO `target`, on top of any existing exposure there) so that the POST-move
 * exposure does not exceed the protocol's effective cap. Rounds DOWN so the
 * cap is never exceeded due to floating-point creep.
 */
export function clampMoveToCap(
  target: string,
  moveFraction: number,
  snapshot: ExposureSnapshot,
  cap: EffectiveExposureCap,
  total: number = 0
): {
  clampedMove: number
  postMoveFraction: number
  boundedBy: 'fraction' | 'absolute' | 'none'
} {
  const currentFraction = snapshot.fractions[target] ?? 0
  const headroom = availableFractionHeadroom(target, snapshot, cap, total)
  const boundedMove = Math.max(0, Math.min(moveFraction, headroom))

  let postMoveFraction = currentFraction + boundedMove
  let boundedBy: 'fraction' | 'absolute' | 'none'

  // Determine what actually bound the move.
  const effectiveBound = effectiveFractionBound(
    cap,
    total > 0 ? total : Number(snapshot.totalValue ?? 0)
  )
  if (boundedMove < moveFraction - 1e-12) {
    boundedBy =
      cap.maxAbsolute !== undefined && effectiveBound < cap.maxFraction - 1e-12
        ? 'absolute'
        : 'fraction'
  } else {
    boundedBy = 'none'
  }

  // Round down defensively: if floating point nudged us a hair over the bound
  // (only possible when we actually moved a positive amount), snap back so the
  // cap is never exceeded. If the protocol was ALREADY over cap (boundedMove 0),
  // postMoveFraction reflects the true current state — an over-cap position is
  // corrected by the loop's over-cap rebalance path, not silently relabelled.
  if (boundedMove > 0 && postMoveFraction > effectiveBound + 1e-12) {
    postMoveFraction = effectiveBound
  }

  return { clampedMove: boundedMove, postMoveFraction, boundedBy }
}

/**
 * Sum of the effective caps over an eligible set, as a fraction. Used to detect
 * whether a portfolio is placeable: if the sum < 1 (less than 100%), no legal
 * combination can fully place the funds and a remainder must stay put.
 */
export function sumCaps(
  eligibleProtocols: string[],
  snapshot: ExposureSnapshot,
  caps: Record<string, EffectiveExposureCap>,
  total: number = 0
): number {
  let sum = 0
  for (const p of eligibleProtocols) {
    const eff = caps[p]
    if (!eff) continue
    sum += effectiveFractionBound(
      eff,
      total > 0 ? total : Number(snapshot.totalValue ?? 0)
    )
  }
  return Math.min(1, sum)
}

/**
 * Normalize a portfolio's raw absolute values into an ExposureSnapshot,
 * computing fractions. Values are Decimal-string/numbers; the total is their
 * sum. When total is 0 the fractions are all 0 (nothing to expose).
 */
export function buildExposureSnapshot(
  absolute: Record<string, string | number>
): ExposureSnapshot {
  const values = Object.entries(absolute).map(([, v]) => Number(v))
  const total = values.reduce((s, v) => s + v, 0)
  const fractions: Record<string, number> = {}
  for (const [protocol, value] of Object.entries(absolute)) {
    fractions[protocol] = total > 0 ? Number(value) / total : 0
  }
  const absStrings: Record<string, string> = {}
  for (const [protocol, value] of Object.entries(absolute)) {
    absStrings[protocol] = String(value)
  }
  return {
    fractions,
    absolute: absStrings,
    totalValue: String(total),
  }
}

/**
 * Validate a raw exposure-caps override structure (as it arrives from Json
 * strategyConfig). Returns the set of issues, or an empty array when valid.
 *
 * Validation rules:
 *  - perProtocol values must carry a maxFraction in [0,1] and/or a maxAbsolute
 *    >= 0.
 *  - Unknown extra keys are rejected.
 *  - defaultMaxFraction must be in [0,1] when present.
 */
export function validateExposureCapConfig(raw: unknown): string[] {
  const issues: string[] = []
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return ['exposureCaps must be an object']
  }

  const obj = raw as Record<string, unknown>

  if (obj.defaultMaxFraction !== undefined) {
    const v = obj.defaultMaxFraction
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
      issues.push('defaultMaxFraction must be a number in [0, 1]')
    }
  }

  if (obj.perProtocol !== undefined) {
    if (
      typeof obj.perProtocol !== 'object' ||
      obj.perProtocol === null ||
      Array.isArray(obj.perProtocol)
    ) {
      issues.push(
        'exposureCaps.perProtocol must be an object keyed by protocol name'
      )
    } else {
      const protocols = obj.perProtocol as Record<string, unknown>
      for (const [protocol, override] of Object.entries(protocols)) {
        if (
          typeof override !== 'object' ||
          override === null ||
          Array.isArray(override)
        ) {
          issues.push(
            `exposureCaps.perProtocol.${protocol} must be an object with maxFraction and/or maxAbsolute`
          )
          continue
        }
        const o = override as Record<string, unknown>
        const keys = Object.keys(o)
        for (const k of keys) {
          if (k !== 'maxFraction' && k !== 'maxAbsolute') {
            issues.push(
              `exposureCaps.perProtocol.${protocol}.${k} is not a recognized key`
            )
          }
        }
        if (o.maxFraction !== undefined) {
          const mf = o.maxFraction
          if (
            typeof mf !== 'number' ||
            !Number.isFinite(mf) ||
            mf <= 0 ||
            mf > 1
          ) {
            issues.push(
              `exposureCaps.perProtocol.${protocol}.maxFraction must be a number in (0, 1]`
            )
          }
        }
        if (o.maxAbsolute !== undefined) {
          const ma = o.maxAbsolute
          const num = typeof ma === 'string' ? Number(ma) : ma
          if (typeof num !== 'number' || !Number.isFinite(num) || num < 0) {
            issues.push(
              `exposureCaps.perProtocol.${protocol}.maxAbsolute must be a non-negative number`
            )
          }
        }
      }
    }
  }

  return issues
}

/**
 * A single destination in a capped allocation plan.
 */
export interface CappedAllocation {
  protocol: string
  /** Fraction of the total portfolio value routed here. */
  fraction: number
  /** True when this destination hit its cap and could not take more. */
  capped: boolean
  /** Which bound stopped it, when capped. */
  boundedBy: 'fraction' | 'absolute' | 'none'
}

/**
 * Allocation plan result. `unplacedFraction` is the fraction of the portfolio
 * that could not be placed under the caps (sum of caps < 100%) and must stay in
 * the current protocol.
 */
export interface CappedAllocationPlan {
  allocations: CappedAllocation[]
  unplacedFraction: number
  overCapProtocols: string[]
}

/**
 * Plan how to distribute `toAllocateFraction` of the portfolio across an
 * ordered list of preferred target protocols, honouring each protocol's
 * effective cap given current exposure. Residual is left unplaced (the caller
 * leaves it in the current protocol) — a cap is NEVER violated to force
 * placement.
 *
 * `preferredOrder` is the ranking produced by the strategy (best APY first for
 * MaxYield). Protocols are filled greedily up to their headroom.
 */
export function planCappedRebalance(
  preferredOrder: string[],
  toAllocateFraction: number,
  snapshot: ExposureSnapshot,
  caps: Record<string, EffectiveExposureCap>,
  total: number = 0
): CappedAllocationPlan {
  const allocations: CappedAllocation[] = []
  let remaining = toAllocateFraction
  const overCapProtocols: string[] = []

  // Detect pre-existing over-cap holdings across the WHOLE portfolio, not just
  // the preferred order — the caller needs the full set to trigger the
  // concentration-correction path.
  for (const protocol of Object.keys(snapshot.fractions)) {
    const eff = caps[protocol]
    if (
      eff &&
      (snapshot.fractions[protocol] ?? 0) > eff.maxFraction + 1e-12 &&
      !overCapProtocols.includes(protocol)
    ) {
      overCapProtocols.push(protocol)
    }
  }

  for (const protocol of preferredOrder) {
    if (remaining <= 1e-12) break
    const eff = caps[protocol]
    if (!eff) continue

    const headroom = availableFractionHeadroom(protocol, snapshot, eff, total)
    if (headroom <= 1e-12) {
      allocations.push({
        protocol,
        fraction: 0,
        capped: true,
        boundedBy: 'fraction',
      })
      continue
    }

    const take = Math.min(remaining, headroom)
    const boundedBy = eff.maxAbsolute !== undefined ? 'absolute' : 'fraction'
    allocations.push({
      protocol,
      fraction: take,
      capped: take < remaining - 1e-12,
      boundedBy,
    })
    remaining -= take
  }

  return {
    allocations,
    unplacedFraction: remaining > 1e-12 ? remaining : 0,
    overCapProtocols,
  }
}
