/**
 * Mean-variance portfolio optimizer — pure computation (#322).
 *
 * STRUCTURAL GUARANTEE (see tests/unit/analytics/structural.test.ts):
 * Nothing under src/analytics/ may import from src/stellar/*, touch a wallet, or
 * write User.strategyConfig. A suggestion is ADVISORY: it is computed, persisted
 * and displayed, and a human tap applies it through the already-validated
 * strategy update path. That is enforced by a source-scanning test, not by
 * convention.
 *
 * ─── THE OBJECTIVE ───────────────────────────────────────────────────────────
 *
 *   maximize   mu' w  -  (lambda / 2) * w' Sigma w
 *   subject to sum(w) = 1
 *              lo_i <= w_i <= hi_i
 *              sum_{i in S} w_i >= f        (optional stable-group floor)
 *
 * The risk ceiling is NOT a term here. It enters upstream as a universe filter
 * via applyRiskCeiling (src/agent/strategies.ts), so the fail-closed rule
 * "unknown score => excluded" is shared with the strategy engine rather than
 * reimplemented. A weighted portfolio risk score is REPORTED for display but
 * never separately constrained — one notion of the ceiling, not two.
 *
 * ─── WHY LAMBDA IS [5, 500] AND NOT [1, 25] ──────────────────────────────────
 *
 * A deliberate, measured deviation from plan.md; see ASSUMPTIONS.md.
 *
 * plan.md specified daily returns r = apy/100/365.25 with Sigma annualized by
 * *365.25, and lambda linear on [1, 25]. Under those units the risk term is five
 * to six orders of magnitude below the return term for realistic APY dispersion
 * (a protocol whose APY swings +/-2 percentage points has an annualized variance
 * of ~5e-7 in that scaling, against a mean return of ~8e-2). The consequence is
 * not "slightly aggressive" — it is that (lambda/2) w'Sigma w can never offset
 * mu'w at any lambda in [1,25], so the optimum is ALWAYS the max-return corner,
 * the efficient frontier collapses to a single point, and the whole engine
 * degenerates into "put everything in the highest-APY protocol".
 *
 * So Sigma here is the covariance of protocols' ANNUAL RATE LEVELS — exactly
 * plan.md's matrix multiplied by 365.25. Two things follow:
 *   - expectedVolatility comes out in the same units as the APY itself, so
 *     "8.2% expected return, 1.4% expected volatility" is directly readable.
 *   - lambda must live on [5, 500] to span the useful trade-off. Log-spaced
 *     rather than linear, which is the natural parameterization for a risk-
 *     aversion coefficient (each step is a constant RATIO of risk appetite).
 * Worked numbers are in docs/PORTFOLIO_OPTIMIZATION.md.
 *
 * ─── DETERMINISM ─────────────────────────────────────────────────────────────
 *
 * The same input must produce byte-identical output, because the API returns an
 * input-snapshot hash and users compare suggestions across time. Guaranteed by:
 * protocols sorted by name (and mu/Sigma permuted to match) regardless of caller
 * ordering, a fixed uniform-feasible starting point, a fixed iteration budget,
 * and no randomness anywhere in this file.
 */

import {
  AllocationBounds,
  BindingConstraint,
  FrontierPoint,
  OptimizationOutcome,
  OptimizerInput,
  StableGroupFloor,
  UniverseExclusion,
} from './types'

// ── Tunables (mirror docs/PORTFOLIO_OPTIMIZATION.md) ─────────────────────────

/** Risk-aversion at riskTolerance = 1 (most risk-averse). */
export const LAMBDA_MAX = 500

/** Risk-aversion at riskTolerance = 10 (most risk-seeking). */
export const LAMBDA_MIN = 5

/** Fewer than this many assets is not a portfolio. */
export const MIN_UNIVERSE_SIZE = 2

/**
 * Default per-protocol concentration cap — a DIVERSIFICATION GUARDRAIL, not a
 * term in the objective.
 *
 * Unconstrained mean-variance is famously corner-seeking ("error maximization",
 * Michaud 1989): it treats a historical mean as if it were known exactly, so a
 * protocol whose APY averaged 3 percentage points above its peers absorbs the
 * whole book unless something stops it. Measured on this repo's own scale — a
 * 3pp return spread against ~1.8pp yield volatility, with the correlated rate
 * histories DeFi protocols actually exhibit — every riskTolerance from 3 to 10
 * returns a single protocol at 100%.
 *
 * That is a true optimum of the stated objective and simultaneously terrible
 * advice: the estimate behind it is far noisier than the optimizer's precision
 * implies, and this endpoint's entire purpose is to suggest a DIVERSIFIED
 * allocation. So the cap is applied as an explicit, documented, overridable
 * constraint (`bounds.max` wins over it) rather than by quietly distorting mu or
 * lambda until the answer looks reasonable.
 *
 * Raised to 1/n when the universe is too small to satisfy it, so the feasible
 * set is never emptied by the guardrail itself.
 */
export const DEFAULT_MAX_WEIGHT_PER_PROTOCOL = 0.6

/** Frontier resolution. The hard cap bounds per-request CPU. */
export const DEFAULT_FRONTIER_POINTS = 12
export const MAX_FRONTIER_POINTS = 25

/**
 * Projected-gradient budget. Convergence is typically reached in tens to low
 * hundreds of iterations; the budget exists so a pathological Sigma yields an
 * honest `non_converged` rather than an unbounded loop.
 */
export const MAX_ITERATIONS = 2000

/** Iterate-movement below this counts as a fixed point. */
export const CONVERGENCE_TOLERANCE = 1e-12

/**
 * Bisection steps for the capped-simplex projection. The bracket halves each
 * step, so 80 steps takes a bracket of width ~20 to ~1e-23 — below double
 * precision. Fixed rather than tolerance-driven so the cost is deterministic.
 */
const BISECTION_ITERATIONS = 80

/**
 * Cap on how far one gradient step may move the iterate before projection.
 *
 * Weights live in [0,1], so a step of more than a few units is pure overshoot
 * that the projection immediately undoes. It matters numerically: with a
 * near-zero Sigma (all-identical APY history) the Lipschitz bound collapses and
 * 1/L explodes, pushing the pre-projection vector to ~1e6. The bisection
 * bracket scales with that magnitude, and 80 halvings of a 1e6-wide bracket
 * leaves ~1e-18 per element — enough drift to break "weights sum to 1" at the
 * twelfth decimal. Capping the movement keeps the bracket O(10) and the sum
 * exact to machine precision. Any step <= 1/L is convergent, so this is safe.
 */
const MAX_STEP_MOVEMENT = 10

/** Weights below this (0.005%) are dropped when emitting percentages. */
const PERCENT_DUST_THRESHOLD = 5e-5

// ── Risk-aversion mapping ────────────────────────────────────────────────────

/**
 * Map a 1-10 riskTolerance onto the risk-aversion coefficient lambda.
 *
 * Log-spaced and DECREASING: riskTolerance 1 => LAMBDA_MAX (most risk-averse),
 * riskTolerance 10 => LAMBDA_MIN (most risk-seeking). Values outside 1-10 are
 * clamped rather than rejected — User.riskTolerance is an Int column with no
 * database-level range check.
 */
export function riskToleranceToLambda(riskTolerance: number): number {
  const rt = Number.isFinite(riskTolerance)
    ? Math.min(10, Math.max(1, riskTolerance))
    : 5
  const t = (rt - 1) / 9
  return LAMBDA_MAX * Math.pow(LAMBDA_MIN / LAMBDA_MAX, t)
}

// ── Small linear algebra helpers ─────────────────────────────────────────────

function dot(a: number[], b: number[]): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

function matVec(m: number[][], v: number[]): number[] {
  const out = new Array<number>(v.length).fill(0)
  for (let i = 0; i < m.length; i++) {
    let s = 0
    const row = m[i]
    for (let j = 0; j < v.length; j++) s += row[j] * v[j]
    out[i] = s
  }
  return out
}

function quadraticForm(m: number[][], v: number[]): number {
  return dot(v, matVec(m, v))
}

function sum(v: number[]): number {
  let s = 0
  for (const x of v) s += x
  return s
}

function maxAbsDiff(a: number[], b: number[]): number {
  let m = 0
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i])
    if (d > m) m = d
  }
  return m
}

/**
 * Gershgorin upper bound on the largest eigenvalue of a symmetric matrix: the
 * maximum absolute row sum. Used as the Lipschitz constant L of the gradient of
 * (lambda/2) w'Sigma w, giving the safe projected-gradient step 1/L.
 */
function gershgorinBound(m: number[][]): number {
  let max = 0
  for (const row of m) {
    let s = 0
    for (const v of row) s += Math.abs(v)
    if (s > max) max = s
  }
  return max
}

// ── Projections ──────────────────────────────────────────────────────────────

/**
 * Exact Euclidean projection onto the capped simplex {sum(w) = 1, lo <= w <= hi}.
 *
 * The projection has the closed form w_i(theta) = clamp(v_i - theta, lo_i, hi_i)
 * for the unique theta making sum(w) = 1. That sum is monotone NON-INCREASING in
 * theta, so bisection on theta converges to machine precision — no iterative
 * solver, no tolerance to tune, and the answer is exact rather than approximate.
 *
 * Caller must have already checked feasibility (sum(lo) <= 1 <= sum(hi)); with
 * an infeasible box the bracket below cannot straddle 1 and the result would be
 * meaningless. checkFeasibility() is that gate.
 */
export function projectOntoCappedSimplex(
  v: number[],
  lo: number[],
  hi: number[],
  target = 1
): number[] {
  const n = v.length
  const clampedSum = (theta: number): number => {
    let s = 0
    for (let i = 0; i < n; i++) {
      const x = v[i] - theta
      s += x < lo[i] ? lo[i] : x > hi[i] ? hi[i] : x
    }
    return s
  }

  // Bracket theta so that clampedSum(low) >= target >= clampedSum(high).
  let low = -1
  let high = 1
  for (let i = 0; i < n; i++) {
    low = Math.min(low, v[i] - hi[i] - 1)
    high = Math.max(high, v[i] - lo[i] + 1)
  }

  for (let k = 0; k < BISECTION_ITERATIONS; k++) {
    const mid = (low + high) / 2
    if (clampedSum(mid) > target) low = mid
    else high = mid
  }

  const theta = (low + high) / 2
  const out = new Array<number>(n)
  for (let i = 0; i < n; i++) {
    const x = v[i] - theta
    out[i] = x < lo[i] ? lo[i] : x > hi[i] ? hi[i] : x
  }
  return out
}

/** Project the sub-vector at `idx` onto its own capped simplex summing to `target`. */
function projectSubset(
  v: number[],
  lo: number[],
  hi: number[],
  idx: number[],
  target: number,
  out: number[]
): void {
  const sub = projectOntoCappedSimplex(
    idx.map((i) => v[i]),
    idx.map((i) => lo[i]),
    idx.map((i) => hi[i]),
    target
  )
  idx.forEach((i, k) => {
    out[i] = sub[k]
  })
}

/**
 * Exact Euclidean projection onto {sum(w)=1, lo<=w<=hi, sum_{i in S} w_i >= f}.
 *
 * DELIBERATE SIMPLIFICATION OF plan.md, which called for Dykstra's alternating
 * projections here. Dykstra is the right tool for a general intersection of
 * convex sets, but it is only ITERATIVELY convergent, and — as the smoke test
 * for this file caught — it is easy to leave the iterate on the wrong side of
 * one of the two sets. This geometry does not need it.
 *
 * For a convex set A and a halfspace B: P_{A∩B}(v) = P_A(v) when P_A(v) already
 * lies in B, and otherwise the projection lies on the boundary ∂B. Here that
 * boundary is
 *
 *     {sum_S w = f} ∩ {sum(w) = 1} ∩ box  ==  {sum_S w = f} ∩ {sum_{S^c} w = 1-f} ∩ box
 *
 * — two capped simplices over DISJOINT index groups. Euclidean distance
 * separates across disjoint coordinates, so projecting each group onto its own
 * target sum is the exact projection onto the intersection. No iteration, no
 * tolerance, and the floor cannot be silently violated.
 *
 * The `stableSum >= f` fast path is also the no-floor path, so a user with no
 * stable-group floor pays one capped-simplex projection, exactly as before.
 */
function projectOntoFeasibleSet(
  v: number[],
  lo: number[],
  hi: number[],
  stableIdx: number[],
  nonStableIdx: number[],
  minWeight: number | null
): number[] {
  const simple = projectOntoCappedSimplex(v, lo, hi)
  if (minWeight === null || stableIdx.length === 0) return simple

  let stableSum = 0
  for (const i of stableIdx) stableSum += simple[i]
  if (stableSum >= minWeight - 1e-12) return simple

  // Floor binds: the optimum sits on sum_S w = f. Project each disjoint group
  // onto its own capped simplex.
  const out = new Array<number>(v.length).fill(0)
  projectSubset(v, lo, hi, stableIdx, minWeight, out)
  projectSubset(v, lo, hi, nonStableIdx, 1 - minWeight, out)
  return out
}

// ── Feasibility ──────────────────────────────────────────────────────────────

export interface FeasibilityFailure {
  reason: string
  bindingConstraint: BindingConstraint
}

/**
 * Up-front feasibility of {sum(w)=1, lo<=w<=hi, sum_S w >= f}, naming the
 * binding constraint. Checked BEFORE any solving so an impossible request
 * returns a precise explanation instead of a vector that silently violates
 * something.
 */
export function checkFeasibility(
  lo: number[],
  hi: number[],
  stableIdx: number[],
  nonStableIdx: number[],
  minWeight: number | null
): FeasibilityFailure | null {
  const loSum = sum(lo)
  const hiSum = sum(hi)

  if (loSum > 1 + 1e-9) {
    return {
      reason: `Minimum weights sum to ${(loSum * 100).toFixed(2)}%, which exceeds 100%`,
      bindingConstraint: 'minWeights',
    }
  }
  if (hiSum < 1 - 1e-9) {
    return {
      reason: `Maximum weights sum to ${(hiSum * 100).toFixed(2)}%, which cannot reach 100%`,
      bindingConstraint: 'maxWeights',
    }
  }

  if (minWeight !== null) {
    if (minWeight > 1 + 1e-9) {
      return {
        reason: `Stable-asset floor of ${(minWeight * 100).toFixed(2)}% exceeds 100%`,
        bindingConstraint: 'stableFloor',
      }
    }

    let stableHi = 0
    for (const i of stableIdx) stableHi += hi[i]
    if (stableHi < minWeight - 1e-9) {
      return {
        reason: `Stable-asset floor of ${(minWeight * 100).toFixed(2)}% exceeds the ${(stableHi * 100).toFixed(2)}% those protocols are collectively capped at`,
        bindingConstraint: 'stableFloor',
      }
    }

    let nonStableLo = 0
    let nonStableHi = 0
    for (const i of nonStableIdx) {
      nonStableLo += lo[i]
      nonStableHi += hi[i]
    }
    if (nonStableLo > 1 - minWeight + 1e-9) {
      return {
        reason: `Stable-asset floor of ${(minWeight * 100).toFixed(2)}% leaves only ${((1 - minWeight) * 100).toFixed(2)}% for other protocols, whose minimums already sum to ${(nonStableLo * 100).toFixed(2)}%`,
        bindingConstraint: 'stableFloor',
      }
    }
    // The floor also caps the stable group at f when it binds, so the rest of
    // the book must be able to absorb the remaining 1-f on its own.
    if (nonStableHi < 1 - minWeight - 1e-9) {
      return {
        reason: `Stable-asset floor of ${(minWeight * 100).toFixed(2)}% leaves ${((1 - minWeight) * 100).toFixed(2)}% for other protocols, which are collectively capped at ${(nonStableHi * 100).toFixed(2)}%`,
        bindingConstraint: 'stableFloor',
      }
    }
  }

  return null
}

// ── Solver ───────────────────────────────────────────────────────────────────

interface SolveResult {
  weights: number[]
  iterations: number
  residual: number
  converged: boolean
}

/**
 * ACCELERATED projected gradient ascent (FISTA) on the concave objective.
 *
 * Sigma is a sample covariance matrix and therefore PSD, so -(lambda/2) w'Sigma w
 * is concave and mu'w is linear: the objective is concave, the feasible set is
 * convex and compact, and projected gradient with step 1/L converges to the
 * global maximum.
 *
 * ─── WHY ACCELERATION, NOT PLAIN GRADIENT ────────────────────────────────────
 *
 * Sigma is estimated as a sample covariance over ~90 observations. When the
 * number of protocols approaches the number of observations — or two protocols'
 * APYs move nearly together, which is the norm in DeFi — Sigma is ill-conditioned
 * or outright rank-deficient. The objective is then concave but NOT strongly
 * concave, and plain projected gradient converges at a sublinear O(1/k) rate.
 * Measured on this file's own property tests, a 7-protocol problem still had a
 * 5.2e-8 residual after the full 2000-iteration budget and reported
 * `non_converged` despite sitting on a perfectly good allocation. Reaching a
 * 1e-10 residual that way would need on the order of a million iterations.
 *
 * Nesterov's momentum gives O(1/k^2) for the same per-iteration cost and closes
 * that gap in a few hundred iterations. The ADAPTIVE RESTART is what makes it
 * safe: momentum can overshoot and temporarily reduce the objective, so whenever
 * an iterate is worse than its predecessor the momentum is reset. That keeps the
 * sequence effectively monotone without giving up the acceleration.
 *
 * Every iterate is a projection onto the feasible set, so EVERY intermediate
 * value satisfies every constraint. That is what makes `bestFeasibleWeights` in
 * the non_converged outcome safe to hand back.
 */
function solve(
  mu: number[],
  sigma: number[][],
  lambda: number,
  lo: number[],
  hi: number[],
  stableIdx: number[],
  nonStableIdx: number[],
  minWeight: number | null
): SolveResult {
  const n = mu.length

  // Deterministic start: the uniform vector projected onto the feasible set.
  let w = projectOntoFeasibleSet(
    new Array<number>(n).fill(1 / n),
    lo,
    hi,
    stableIdx,
    nonStableIdx,
    minWeight
  )

  // L bounds the gradient's Lipschitz constant. The floor keeps a zero/degenerate
  // Sigma (all-identical APY history) from producing an infinite step.
  const L = Math.max(lambda * gershgorinBound(sigma), 1e-8)
  const step = 1 / L

  const objective = (v: number[]): number =>
    dot(mu, v) - (lambda / 2) * quadraticForm(sigma, v)

  let best = w
  let bestObj = objective(w)
  let residual = Number.POSITIVE_INFINITY
  let iterations = 0
  let converged = false

  // Momentum state. `y` is the extrapolated point the gradient is taken at.
  let y = w
  let prevObj = bestObj
  let t = 1

  for (let k = 1; k <= MAX_ITERATIONS; k++) {
    iterations = k

    const sy = matVec(sigma, y)
    const grad = new Array<number>(n)
    let gradInf = 0
    for (let i = 0; i < n; i++) {
      grad[i] = mu[i] - lambda * sy[i]
      const a = Math.abs(grad[i])
      if (a > gradInf) gradInf = a
    }

    // See MAX_STEP_MOVEMENT: never move further than the projection can
    // meaningfully use. A step below 1/L is still convergent.
    const effStep =
      gradInf > 0 ? Math.min(step, MAX_STEP_MOVEMENT / gradInf) : step

    const ascent = new Array<number>(n)
    for (let i = 0; i < n; i++) ascent[i] = y[i] + effStep * grad[i]

    const next = projectOntoFeasibleSet(
      ascent,
      lo,
      hi,
      stableIdx,
      nonStableIdx,
      minWeight
    )

    residual = maxAbsDiff(next, w)

    const nextObj = objective(next)
    if (nextObj > bestObj) {
      bestObj = nextObj
      best = next
    }

    if (nextObj < prevObj) {
      // Adaptive restart: momentum overshot. Drop it and continue from the
      // plain iterate rather than letting the overshoot compound.
      t = 1
      y = next
    } else {
      const tNext = (1 + Math.sqrt(1 + 4 * t * t)) / 2
      const beta = (t - 1) / tNext
      const extrapolated = new Array<number>(n)
      for (let i = 0; i < n; i++) {
        extrapolated[i] = next[i] + beta * (next[i] - w[i])
      }
      // Re-project: the extrapolated point can leave the feasible set, and the
      // next gradient must be taken somewhere feasible for the step bound to
      // mean anything.
      y = projectOntoFeasibleSet(
        extrapolated,
        lo,
        hi,
        stableIdx,
        nonStableIdx,
        minWeight
      )
      t = tNext
    }

    prevObj = nextObj
    w = next

    if (residual < CONVERGENCE_TOLERANCE) {
      converged = true
      break
    }
  }

  return { weights: best, iterations, residual, converged }
}

// ── Public API ───────────────────────────────────────────────────────────────

function toWeightMap(
  protocols: string[],
  weights: number[]
): Record<string, number> {
  const out: Record<string, number> = {}
  for (let i = 0; i < protocols.length; i++) out[protocols[i]] = weights[i]
  return out
}

/**
 * Log-spaced lambda grid, DESCENDING, so the frontier comes out ascending in
 * risk (a larger lambda buys less risk). Not sorted after the fact: sorting
 * would paper over a non-monotone sweep instead of exposing it.
 */
function lambdaGrid(points: number): number[] {
  if (points <= 1) return [riskToleranceToLambda(5)]
  const out: number[] = []
  for (let i = 0; i < points; i++) {
    const t = i / (points - 1)
    out.push(LAMBDA_MAX * Math.pow(LAMBDA_MIN / LAMBDA_MAX, t))
  }
  return out
}

/**
 * Solve the mean-variance problem and sweep the efficient frontier.
 *
 * The universe filter (risk ceiling, insufficient history) is applied UPSTREAM
 * in estimation.ts — by the time input reaches here, `protocols` is already the
 * eligible set. `excludedFromUniverse` is threaded through only so the
 * insufficient_universe outcome can explain itself.
 */
export function optimize(
  input: OptimizerInput,
  excludedFromUniverse: UniverseExclusion[] = []
): OptimizationOutcome {
  // Sort by name and permute mu/Sigma to match, so the result cannot depend on
  // the caller's ordering. This is a determinism guarantee, not a nicety.
  const order = input.protocols
    .map((name, i) => ({ name, i }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  const protocols = order.map((o) => o.name)
  const mu = order.map((o) => input.expectedReturns[o.i])
  const sigma = order.map((a) => order.map((b) => input.covariance[a.i][b.i]))

  const n = protocols.length

  if (n < MIN_UNIVERSE_SIZE) {
    const ceilingExcluded = excludedFromUniverse.some(
      (e) => e.reason === 'risk_ceiling'
    )
    return {
      status: 'insufficient_universe',
      eligibleCount: n,
      excluded: excludedFromUniverse,
      ...(ceilingExcluded
        ? { bindingConstraint: 'riskCeiling' as BindingConstraint }
        : {}),
    }
  }

  const { lo, hi } = resolveBounds(protocols, input.bounds)
  const { stableIdx, nonStableIdx, minWeight } = resolveFloor(
    protocols,
    input.stableFloor
  )

  const infeasible = checkFeasibility(
    lo,
    hi,
    stableIdx,
    nonStableIdx,
    minWeight
  )
  if (infeasible) {
    return {
      status: 'infeasible',
      reason: infeasible.reason,
      bindingConstraint: infeasible.bindingConstraint,
    }
  }

  const lambda = riskToleranceToLambda(input.riskTolerance)
  const primary = solve(
    mu,
    sigma,
    lambda,
    lo,
    hi,
    stableIdx,
    nonStableIdx,
    minWeight
  )

  if (!primary.converged) {
    return {
      status: 'non_converged',
      bestFeasibleWeights: toWeightMap(protocols, primary.weights),
      expectedReturn: dot(mu, primary.weights),
      expectedVolatility: Math.sqrt(
        Math.max(0, quadraticForm(sigma, primary.weights))
      ),
      iterations: primary.iterations,
      residual: primary.residual,
    }
  }

  const requested = input.frontierPoints ?? DEFAULT_FRONTIER_POINTS
  const points = Math.max(1, Math.min(MAX_FRONTIER_POINTS, requested))

  const frontier: FrontierPoint[] = lambdaGrid(points).map((gridLambda) => {
    const r = solve(
      mu,
      sigma,
      gridLambda,
      lo,
      hi,
      stableIdx,
      nonStableIdx,
      minWeight
    )
    return {
      lambda: gridLambda,
      risk: Math.sqrt(Math.max(0, quadraticForm(sigma, r.weights))),
      return: dot(mu, r.weights),
      weights: toWeightMap(protocols, r.weights),
    }
  })

  const weights = toWeightMap(protocols, primary.weights)

  const outcome: OptimizationOutcome = {
    status: 'ok',
    weights,
    expectedReturn: dot(mu, primary.weights),
    expectedVolatility: Math.sqrt(
      Math.max(0, quadraticForm(sigma, primary.weights))
    ),
    lambda,
    frontier,
    iterations: primary.iterations,
  }

  if (input.riskScores) {
    let score = 0
    for (let i = 0; i < n; i++) {
      score += primary.weights[i] * (input.riskScores[protocols[i]] ?? 0)
    }
    outcome.portfolioRiskScore = score
  }

  return outcome
}

function resolveBounds(
  protocols: string[],
  bounds: AllocationBounds | undefined
): { lo: number[]; hi: number[] } {
  // Never below 1/n, so the guardrail alone can never empty the feasible set.
  const defaultCap = Math.max(
    DEFAULT_MAX_WEIGHT_PER_PROTOCOL,
    1 / protocols.length
  )

  const lo = protocols.map((p) => {
    const v = bounds?.min?.[p]
    return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : 0
  })
  const hi = protocols.map((p) => {
    const v = bounds?.max?.[p]
    // An explicit cap from the caller wins over the guardrail, in either
    // direction — this is a default, not a policy the caller cannot escape.
    return typeof v === 'number' && Number.isFinite(v)
      ? Math.min(1, v)
      : defaultCap
  })
  // A max below its own min is a caller error that would make the bisection
  // bracket meaningless; widen the max rather than silently inverting the box.
  for (let i = 0; i < lo.length; i++) {
    if (hi[i] < lo[i]) hi[i] = lo[i]
  }
  return { lo, hi }
}

function resolveFloor(
  protocols: string[],
  floor: StableGroupFloor | undefined
): {
  stableIdx: number[]
  nonStableIdx: number[]
  minWeight: number | null
} {
  const allIdx = protocols.map((_, i) => i)
  if (!floor || !(floor.minWeight > 0)) {
    return { stableIdx: [], nonStableIdx: allIdx, minWeight: null }
  }
  const wanted = new Set(floor.protocols)
  const stableIdx: number[] = []
  const nonStableIdx: number[] = []
  for (let i = 0; i < protocols.length; i++) {
    if (wanted.has(protocols[i])) stableIdx.push(i)
    else nonStableIdx.push(i)
  }
  // When none of the named stable protocols survived the universe filter the
  // floor is unsatisfiable at any weight (an empty group sums to 0 < f). The
  // minWeight is deliberately kept so checkFeasibility reports it as a
  // stableFloor binding constraint, rather than silently dropping a risk
  // control the user asked for.
  return { stableIdx, nonStableIdx, minWeight: floor.minWeight }
}

/**
 * THE single fraction -> percentage boundary for the whole subsystem.
 *
 * Emits the 0-100 map that User.strategyConfig.targetAllocations speaks, summing
 * to 100 within the +/-0.01 tolerance that publishableConfigSchema.superRefine
 * already enforces (src/validators/strategy-validators.ts) — so a suggestion is
 * directly acceptable by the existing update path with no re-conversion.
 *
 * Rounds to 2dp, drops dust, then settles the rounding residual onto the single
 * largest weight (ties broken by name, for determinism). The residual is at most
 * n * 0.005 percentage points, far inside the tolerance.
 */
export function toPercentageAllocations(
  weights: Record<string, number>
): Record<string, number> {
  const entries = Object.entries(weights)
    .filter(([, w]) => Number.isFinite(w) && w >= PERCENT_DUST_THRESHOLD)
    .map(([name, w]) => [name, Math.round(w * 100 * 100) / 100] as const)
    .filter(([, pct]) => pct > 0)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))

  if (entries.length === 0) return {}

  const total = entries.reduce((s, [, pct]) => s + pct, 0)
  const drift = Math.round((100 - total) * 100) / 100

  let largestIdx = 0
  for (let i = 1; i < entries.length; i++) {
    if (entries[i][1] > entries[largestIdx][1]) largestIdx = i
  }

  const out: Record<string, number> = {}
  entries.forEach(([name, pct], i) => {
    out[name] = i === largestIdx ? Math.round((pct + drift) * 100) / 100 : pct
  })
  return out
}
