/**
 * Portfolio optimizer — property-style unit tests (#322).
 *
 * The solver is new numeric code, so most of what matters here is not "does it
 * return the number I hard-coded" but "does it ALWAYS satisfy the constraints it
 * promises". Hence property tests over a seeded pseudo-random generator: many
 * inputs, invariants asserted on every one, and reproducible on failure because
 * the generator is deterministic.
 *
 * The seeded generator is deliberately hand-rolled rather than Math.random —
 * a failing case must be reproducible from the seed printed in the test name.
 */

import {
  DEFAULT_MAX_WEIGHT_PER_PROTOCOL,
  LAMBDA_MAX,
  LAMBDA_MIN,
  MAX_FRONTIER_POINTS,
  checkFeasibility,
  optimize,
  projectOntoCappedSimplex,
  riskToleranceToLambda,
  toPercentageAllocations,
} from '../../../src/analytics/optimizer'
import { OptimizerInput } from '../../../src/analytics/types'

// ── Seeded generator (mulberry32) ────────────────────────────────────────────

function makeRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * A random PSD covariance matrix, built as A'A so it is positive semi-definite
 * by construction — the concavity the solver relies on is a precondition, not
 * something the test should accidentally violate.
 */
function randomProblem(
  rng: () => number,
  n: number
): { protocols: string[]; mu: number[]; sigma: number[][] } {
  const protocols = Array.from({ length: n }, (_, i) => `P${String(i + 1)}`)
  const mu = Array.from({ length: n }, () => 0.02 + rng() * 0.15)

  const a: number[][] = Array.from({ length: n }, () =>
    Array.from({ length: n }, () => (rng() - 0.5) * 0.05)
  )
  const sigma: number[][] = Array.from({ length: n }, () =>
    new Array<number>(n).fill(0)
  )
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let s = 0
      for (let k = 0; k < n; k++) s += a[k][i] * a[k][j]
      sigma[i][j] = s
      sigma[j][i] = s
    }
  }
  return { protocols, mu, sigma }
}

function sumOf(weights: Record<string, number>): number {
  return Object.values(weights).reduce((s, v) => s + v, 0)
}

describe('riskToleranceToLambda', () => {
  it('maps 1 to the most risk-averse lambda and 10 to the least', () => {
    expect(riskToleranceToLambda(1)).toBeCloseTo(LAMBDA_MAX, 9)
    expect(riskToleranceToLambda(10)).toBeCloseTo(LAMBDA_MIN, 9)
  })

  it('is strictly decreasing across the 1-10 range', () => {
    for (let rt = 1; rt < 10; rt++) {
      expect(riskToleranceToLambda(rt + 1)).toBeLessThan(
        riskToleranceToLambda(rt)
      )
    }
  })

  it('clamps out-of-range and non-finite values rather than throwing', () => {
    // User.riskTolerance is an Int column with no DB-level range check.
    expect(riskToleranceToLambda(0)).toBeCloseTo(LAMBDA_MAX, 9)
    expect(riskToleranceToLambda(99)).toBeCloseTo(LAMBDA_MIN, 9)
    expect(Number.isFinite(riskToleranceToLambda(NaN))).toBe(true)
  })
})

describe('projectOntoCappedSimplex', () => {
  it('hits the target sum exactly and respects the box', () => {
    const rng = makeRng(7)
    for (let trial = 0; trial < 200; trial++) {
      const n = 2 + Math.floor(rng() * 8)
      const v = Array.from({ length: n }, () => (rng() - 0.3) * 3)
      const lo = Array.from({ length: n }, () => rng() * 0.05)
      const hi = lo.map((l) => l + 0.2 + rng() * 0.8)

      // The projection's contract is defined only on a FEASIBLE box; with
      // sum(hi) < 1 there is no point on the simplex to project onto and the
      // function documents checkFeasibility as the caller's gate. Skip those
      // rather than asserting a contract that was never offered.
      if (checkFeasibility(lo, hi, [], [], null) !== null) continue

      const w = projectOntoCappedSimplex(v, lo, hi)

      expect(w.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 10)
      w.forEach((x, i) => {
        expect(x).toBeGreaterThanOrEqual(lo[i] - 1e-12)
        expect(x).toBeLessThanOrEqual(hi[i] + 1e-12)
      })
    }
  })

  it('is idempotent on an already-feasible point', () => {
    const lo = [0, 0, 0]
    const hi = [1, 1, 1]
    const feasible = [0.2, 0.5, 0.3]
    const once = projectOntoCappedSimplex(feasible, lo, hi)
    once.forEach((x, i) => expect(x).toBeCloseTo(feasible[i], 10))
  })
})

describe('checkFeasibility', () => {
  it('names minWeights when the minimums cannot fit in 100%', () => {
    const f = checkFeasibility([0.7, 0.7], [1, 1], [], [0, 1], null)
    expect(f?.bindingConstraint).toBe('minWeights')
  })

  it('names maxWeights when the maximums cannot reach 100%', () => {
    const f = checkFeasibility([0, 0], [0.3, 0.3], [], [0, 1], null)
    expect(f?.bindingConstraint).toBe('maxWeights')
  })

  it('names stableFloor when the stable group cannot reach the floor', () => {
    const f = checkFeasibility([0, 0], [1, 0.2], [1], [0], 0.5)
    expect(f?.bindingConstraint).toBe('stableFloor')
  })

  it('names stableFloor when the rest of the book cannot absorb the remainder', () => {
    // Floor 0.5 leaves 0.5 for non-stables, but they are capped at 0.2 total.
    const f = checkFeasibility([0, 0], [1, 0.2], [0], [1], 0.5)
    expect(f?.bindingConstraint).toBe('stableFloor')
  })

  it('passes a satisfiable configuration', () => {
    expect(checkFeasibility([0, 0], [1, 1], [0], [1], 0.4)).toBeNull()
  })
})

describe('optimize — invariants over seeded random problems', () => {
  const SEEDS = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89]

  it.each(SEEDS)(
    'seed %i: weights sum to 1 and respect every bound',
    (seed) => {
      const rng = makeRng(seed)

      for (let trial = 0; trial < 20; trial++) {
        const n = 2 + Math.floor(rng() * 7)
        const { protocols, mu, sigma } = randomProblem(rng, n)
        const riskTolerance = 1 + Math.floor(rng() * 10)

        const result = optimize({
          protocols,
          expectedReturns: mu,
          covariance: sigma,
          riskTolerance,
          frontierPoints: 5,
        })

        expect(result.status).toBe('ok')
        if (result.status !== 'ok') return

        expect(sumOf(result.weights)).toBeCloseTo(1, 9)

        // Default concentration cap, raised to 1/n on small universes.
        const cap = Math.max(DEFAULT_MAX_WEIGHT_PER_PROTOCOL, 1 / n)
        for (const w of Object.values(result.weights)) {
          expect(w).toBeGreaterThanOrEqual(-1e-12)
          expect(w).toBeLessThanOrEqual(cap + 1e-9)
        }
      }
    }
  )

  it.each(SEEDS)(
    'seed %i: explicit min/max bounds are always respected',
    (seed) => {
      const rng = makeRng(seed + 1000)

      for (let trial = 0; trial < 15; trial++) {
        const n = 3 + Math.floor(rng() * 5)
        const { protocols, mu, sigma } = randomProblem(rng, n)

        const min: Record<string, number> = {}
        const max: Record<string, number> = {}
        protocols.forEach((p) => {
          min[p] = rng() * (0.5 / n)
          max[p] = 0.5 + rng() * 0.5
        })

        const result = optimize({
          protocols,
          expectedReturns: mu,
          covariance: sigma,
          riskTolerance: 1 + Math.floor(rng() * 10),
          bounds: { min, max },
          frontierPoints: 4,
        })

        expect(result.status).toBe('ok')
        if (result.status !== 'ok') return

        expect(sumOf(result.weights)).toBeCloseTo(1, 9)
        for (const [name, w] of Object.entries(result.weights)) {
          expect(w).toBeGreaterThanOrEqual(min[name] - 1e-9)
          expect(w).toBeLessThanOrEqual(max[name] + 1e-9)
        }
      }
    }
  )

  it.each(SEEDS)('seed %i: the stablecoin floor is never violated', (seed) => {
    const rng = makeRng(seed + 2000)

    for (let trial = 0; trial < 15; trial++) {
      const n = 3 + Math.floor(rng() * 5)
      const { protocols, mu, sigma } = randomProblem(rng, n)
      const stable = protocols.slice(0, 1 + Math.floor(rng() * 2))
      const minWeight = 0.3 + rng() * 0.4

      const result = optimize({
        protocols,
        expectedReturns: mu,
        covariance: sigma,
        riskTolerance: 1 + Math.floor(rng() * 10),
        stableFloor: { protocols: stable, minWeight },
        // Lift the concentration cap so the floor is the binding constraint.
        bounds: { max: Object.fromEntries(protocols.map((p) => [p, 1])) },
        frontierPoints: 4,
      })

      expect(result.status).toBe('ok')
      if (result.status !== 'ok') return

      const stableSum = stable.reduce((s, p) => s + (result.weights[p] ?? 0), 0)
      expect(stableSum).toBeGreaterThanOrEqual(minWeight - 1e-9)
      expect(sumOf(result.weights)).toBeCloseTo(1, 9)
    }
  })
})

describe('optimize — determinism', () => {
  const base: OptimizerInput = {
    protocols: ['Zeta', 'Alpha', 'Mid'],
    expectedReturns: [0.11, 0.06, 0.08],
    covariance: [
      [0.0009, 0.0001, 0.0002],
      [0.0001, 0.0001, 0.00005],
      [0.0002, 0.00005, 0.0004],
    ],
    riskTolerance: 5,
  }

  it('produces byte-identical output for the same input twice', () => {
    expect(JSON.stringify(optimize(base))).toBe(JSON.stringify(optimize(base)))
  })

  it('is invariant to the caller ordering the protocols differently', () => {
    // Same problem, rows/cols permuted to match a different protocol order.
    const perm = [1, 2, 0] // Alpha, Mid, Zeta
    const reordered: OptimizerInput = {
      protocols: perm.map((i) => base.protocols[i]),
      expectedReturns: perm.map((i) => base.expectedReturns[i]),
      covariance: perm.map((i) => perm.map((j) => base.covariance[i][j])),
      riskTolerance: base.riskTolerance,
    }
    expect(JSON.stringify(optimize(reordered))).toBe(
      JSON.stringify(optimize(base))
    )
  })
})

describe('optimize — frontier', () => {
  const input: OptimizerInput = {
    protocols: ['A', 'B', 'C'],
    expectedReturns: [0.12, 0.07, 0.09],
    covariance: [
      [0.0016, 0.0002, 0.0004],
      [0.0002, 0.0002, 0.0001],
      [0.0004, 0.0001, 0.0006],
    ],
    riskTolerance: 5,
  }

  it('honours the requested point count and the hard cap', () => {
    const r = optimize({ ...input, frontierPoints: 8 })
    expect(r.status === 'ok' && r.frontier).toHaveLength(8)

    const capped = optimize({ ...input, frontierPoints: 999 })
    expect(capped.status === 'ok' && capped.frontier).toHaveLength(
      MAX_FRONTIER_POINTS
    )
  })

  it('is non-decreasing in risk and in return', () => {
    const r = optimize({ ...input, frontierPoints: 12 })
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return

    for (let i = 1; i < r.frontier.length; i++) {
      expect(r.frontier[i].risk).toBeGreaterThanOrEqual(
        r.frontier[i - 1].risk - 1e-9
      )
      // More risk must buy more return — a frontier point that took on risk for
      // less return would mean the sweep is not tracing an efficient frontier.
      expect(r.frontier[i].return).toBeGreaterThanOrEqual(
        r.frontier[i - 1].return - 1e-9
      )
    }
  })

  it('every frontier point is itself a valid portfolio', () => {
    const r = optimize({ ...input, frontierPoints: 12 })
    if (r.status !== 'ok') throw new Error('expected ok')
    for (const point of r.frontier) {
      expect(sumOf(point.weights)).toBeCloseTo(1, 9)
    }
  })
})

describe('optimize — monotonicity in risk tolerance', () => {
  it('higher riskTolerance gives weakly higher expected return and volatility', () => {
    const input: OptimizerInput = {
      protocols: ['A', 'B'],
      expectedReturns: [0.1, 0.06],
      covariance: [
        [0.0009, 0],
        [0, 0.0001],
      ],
      riskTolerance: 1,
      bounds: { max: { A: 1, B: 1 } },
    }

    let prevReturn = -Infinity
    let prevVol = -Infinity
    for (let rt = 1; rt <= 10; rt++) {
      const r = optimize({ ...input, riskTolerance: rt })
      if (r.status !== 'ok') throw new Error('expected ok')
      expect(r.expectedReturn).toBeGreaterThanOrEqual(prevReturn - 1e-9)
      expect(r.expectedVolatility).toBeGreaterThanOrEqual(prevVol - 1e-9)
      prevReturn = r.expectedReturn
      prevVol = r.expectedVolatility
    }
  })
})

describe('optimize — failure outcomes', () => {
  const twoAsset = {
    expectedReturns: [0.1, 0.06],
    covariance: [
      [0.0009, 0],
      [0, 0.0001],
    ],
    riskTolerance: 5,
  }

  it('returns insufficient_universe below two eligible protocols', () => {
    const r = optimize({
      protocols: ['Solo'],
      expectedReturns: [0.08],
      covariance: [[0.0004]],
      riskTolerance: 5,
    })
    expect(r.status).toBe('insufficient_universe')
    if (r.status !== 'insufficient_universe') return
    expect(r.eligibleCount).toBe(1)
  })

  it('names riskCeiling as the binding constraint when the ceiling emptied the universe', () => {
    const r = optimize(
      {
        protocols: ['Solo'],
        expectedReturns: [0.08],
        covariance: [[0.0004]],
        riskTolerance: 5,
      },
      [
        { protocol: 'Risky', reason: 'risk_ceiling', detail: 'score 40 < 70' },
        { protocol: 'Thin', reason: 'insufficient_history' },
      ]
    )
    expect(r.status).toBe('insufficient_universe')
    if (r.status !== 'insufficient_universe') return
    expect(r.bindingConstraint).toBe('riskCeiling')
    expect(r.excluded).toHaveLength(2)
  })

  it('omits bindingConstraint when the universe was thin for non-ceiling reasons', () => {
    const r = optimize(
      {
        protocols: [],
        expectedReturns: [],
        covariance: [],
        riskTolerance: 5,
      },
      [{ protocol: 'Thin', reason: 'insufficient_history' }]
    )
    expect(r.status).toBe('insufficient_universe')
    if (r.status !== 'insufficient_universe') return
    expect(r.bindingConstraint).toBeUndefined()
  })

  it('returns infeasible with minWeights when minimums exceed 100%', () => {
    const r = optimize({
      ...twoAsset,
      protocols: ['A', 'B'],
      bounds: { min: { A: 0.7, B: 0.7 } },
    })
    expect(r.status).toBe('infeasible')
    if (r.status !== 'infeasible') return
    expect(r.bindingConstraint).toBe('minWeights')
    expect(r.reason).toContain('140.00%')
  })

  it('returns infeasible with maxWeights when maximums cannot reach 100%', () => {
    const r = optimize({
      ...twoAsset,
      protocols: ['A', 'B'],
      bounds: { max: { A: 0.3, B: 0.3 } },
    })
    expect(r.status).toBe('infeasible')
    if (r.status !== 'infeasible') return
    expect(r.bindingConstraint).toBe('maxWeights')
  })

  it('returns infeasible when the stable floor names no surviving protocol', () => {
    const r = optimize({
      ...twoAsset,
      protocols: ['A', 'B'],
      stableFloor: { protocols: ['NotInUniverse'], minWeight: 0.5 },
    })
    expect(r.status).toBe('infeasible')
    if (r.status !== 'infeasible') return
    expect(r.bindingConstraint).toBe('stableFloor')
  })
})

describe('optimize — degenerate covariance', () => {
  it('handles an all-zero Sigma without drifting off the simplex', () => {
    // All-identical APY history: PSD still holds, but the risk term vanishes.
    const r = optimize({
      protocols: ['C', 'A', 'B'],
      expectedReturns: [0.05, 0.05, 0.05],
      covariance: [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
      ],
      riskTolerance: 5,
    })
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(sumOf(r.weights)).toBeCloseTo(1, 12)
    // Ties broken deterministically by name ordering, so the tied solution is
    // the same on every run rather than depending on iteration order.
    expect(Object.keys(r.weights)).toEqual(['A', 'B', 'C'])
  })
})

describe('optimize — reported portfolio risk score', () => {
  it('is the weighted average of the supplied protocol scores', () => {
    const r = optimize({
      protocols: ['A', 'B'],
      expectedReturns: [0.1, 0.06],
      covariance: [
        [0.0009, 0],
        [0, 0.0001],
      ],
      riskTolerance: 5,
      riskScores: { A: 40, B: 90 },
    })
    if (r.status !== 'ok') throw new Error('expected ok')
    const expected = r.weights.A * 40 + r.weights.B * 90
    expect(r.portfolioRiskScore).toBeCloseTo(expected, 9)
  })

  it('is omitted when no scores are supplied', () => {
    const r = optimize({
      protocols: ['A', 'B'],
      expectedReturns: [0.1, 0.06],
      covariance: [
        [0.0009, 0],
        [0, 0.0001],
      ],
      riskTolerance: 5,
    })
    if (r.status !== 'ok') throw new Error('expected ok')
    expect(r.portfolioRiskScore).toBeUndefined()
  })
})

describe('toPercentageAllocations', () => {
  it('sums to 100 within the +/-0.01 tolerance the publish validator enforces', () => {
    const rng = makeRng(4242)
    for (let trial = 0; trial < 300; trial++) {
      const n = 2 + Math.floor(rng() * 8)
      const raw = Array.from({ length: n }, () => rng())
      const total = raw.reduce((s, v) => s + v, 0)
      const weights = Object.fromEntries(
        raw.map((v, i) => [`P${String(i)}`, v / total])
      )

      const pct = toPercentageAllocations(weights)
      const sum = Object.values(pct).reduce((s, v) => s + v, 0)
      expect(Math.abs(sum - 100)).toBeLessThanOrEqual(0.01)
    }
  })

  it('rounds to two decimals', () => {
    const pct = toPercentageAllocations({ A: 1 / 3, B: 1 / 3, C: 1 / 3 })
    for (const v of Object.values(pct)) {
      expect(Number.isInteger(Math.round(v * 100))).toBe(true)
      expect(v).toBeCloseTo(Math.round(v * 100) / 100, 10)
    }
  })

  it('drops dust rather than emitting 0-weight protocols', () => {
    // 1e-6 rounds to 0.00% at two decimals, so emitting it would put a
    // zero-weight protocol into targetAllocations for the agent to rank.
    const pct = toPercentageAllocations({ A: 0.999999, B: 0.000001 })
    expect(pct.B).toBeUndefined()
    expect(pct.A).toBe(100)
  })

  it('keeps a weight that is still representable at two decimals', () => {
    // 0.0001 is 0.01% — small, but exactly representable and not dust.
    const pct = toPercentageAllocations({ A: 0.9999, B: 0.0001 })
    expect(pct.B).toBe(0.01)
    expect(Object.values(pct).reduce((s, v) => s + v, 0)).toBeCloseTo(100, 10)
  })

  it('returns an empty map for an empty input', () => {
    expect(toPercentageAllocations({})).toEqual({})
  })
})
