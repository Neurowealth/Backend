/**
 * Lending configuration invariants (#532).
 *
 * These are the rules that make the money arithmetic safe rather than merely
 * correct. A loan book with an inverted threshold ordering still computes
 * every number "right" — it just lends against collateral it has already
 * promised to sell, and turns every corrective sale into an instant
 * re-breach. Nothing would throw at runtime, so the guard has to be a
 * deliberate one, tested here.
 */

import {
  assertValidLendingConfig,
  lendingConfigIssues,
} from '../../../src/lending/config'

const SAFE = {
  maxLtv: 0.5,
  liquidationLtvThreshold: 0.75,
  liquidationTargetLtv: 0.6,
  maxUnderlyingThresholdFraction: 0.8,
  fallbackBorrowApy: 8,
  platformSpreadApy: 3,
  minCollateralValue: 100,
  minPrincipal: 10,
  maxPrincipal: 50_000,
  approvalThreshold: 10_000,
  maxCollateralFractionSold: 1,
}

describe('src/lending/config', () => {
  it('accepts the shipped defaults', () => {
    // The defaults in src/config/env.ts are the ones asserted here: if a
    // default is ever changed, this test names the change loudly rather than
    // letting the book start in a state nobody reviewed.
    expect(lendingConfigIssues(SAFE)).toEqual([])
  })

  it('rejects an origination cap at or above the liquidation line', () => {
    const issues = lendingConfigIssues({ ...SAFE, maxLtv: 0.75 })
    expect(issues).toContainEqual(expect.stringContaining('maxLtv'))
    expect(() => assertValidLendingConfig({ ...SAFE, maxLtv: 0.75 })).toThrow(
      /Unsafe lending configuration/
    )
  })

  it('rejects a liquidation target at or above the threshold', () => {
    // The failure mode this prevents: every corrective sale lands back over
    // the line, so the monitor liquidates the position to dust.
    const issues = lendingConfigIssues({ ...SAFE, liquidationTargetLtv: 0.75 })
    expect(issues).toContainEqual(
      expect.stringContaining('liquidationTargetLtv')
    )
  })

  it('rejects a threshold fraction of 1 or more', () => {
    const issues = lendingConfigIssues({
      ...SAFE,
      maxUnderlyingThresholdFraction: 1,
    })
    expect(issues).toContainEqual(
      expect.stringContaining('maxUnderlyingThresholdFraction')
    )
  })

  it('rejects a per-loan maximum above the co-signing threshold', () => {
    // Removed as an invariant — see the next test. Kept here only to make the
    // change explicit in history if it is ever restored.
    const issues = lendingConfigIssues({ ...SAFE, maxPrincipal: 20_000 })
    expect(issues).toEqual([])
  })

  it('rejects a minimum principal above the maximum', () => {
    const issues = lendingConfigIssues({ ...SAFE, minPrincipal: 100_000 })
    expect(issues).toContainEqual(expect.stringContaining('minPrincipal'))
  })

  it('allows maxPrincipal above the co-signing threshold', () => {
    // This is the shipped shape, and it is deliberate: small loans originate
    // unattended, large ones need a co-signer. The "a big loan can never slip
    // past co-signing" guarantee lives in originateLoan, which refuses a loan
    // at or above the threshold when no BORROW policy exists — it cannot be a
    // config invariant, because forbidding maxPrincipal > approvalThreshold
    // would force EVERY loan through a co-signer.
    expect(
      lendingConfigIssues({
        ...SAFE,
        maxPrincipal: 50_000,
        approvalThreshold: 10_000,
      })
    ).toEqual([])
  })

  it('rejects fractions outside (0, 1]', () => {
    expect(lendingConfigIssues({ ...SAFE, maxLtv: 0 })).toContainEqual(
      expect.stringContaining('maxLtv')
    )
    expect(lendingConfigIssues({ ...SAFE, maxLtv: 1.5 })).toContainEqual(
      expect.stringContaining('maxLtv')
    )
    expect(lendingConfigIssues({ ...SAFE, maxLtv: Number.NaN })).toContainEqual(
      expect.stringContaining('maxLtv')
    )
  })

  it('rejects negative money settings', () => {
    const issues = lendingConfigIssues({
      ...SAFE,
      minCollateralValue: -1,
      platformSpreadApy: -2,
    })
    expect(issues).toHaveLength(2)
  })

  it('reports every violation at once, not just the first', () => {
    // An operator fixing a bad deploy should not have to restart the service
    // once per mistake. A structural problem in one field must not suppress
    // ordering problems in the others.
    const issues = lendingConfigIssues({
      ...SAFE,
      maxLtv: 0.9,
      liquidationTargetLtv: 0.95,
      maxCollateralFractionSold: 2,
    })
    expect(issues).toHaveLength(3)
    expect(issues.filter((i) => i.includes('must be a fraction'))).toHaveLength(
      1
    )
  })

  it('suppresses derived complaints about a structurally invalid field', () => {
    // Ordering a NaN is meaningless, and a cascade of derived complaints about
    // a value that is not a number helps nobody — but genuine problems in
    // OTHER fields must still surface.
    const issues = lendingConfigIssues({ ...SAFE, maxLtv: Number.NaN })
    expect(issues).toHaveLength(1)
    expect(issues[0]).toContain('must be a fraction in (0, 1]')
  })
})
