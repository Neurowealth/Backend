/**
 * Jurisdiction registry (#356) — a whitelist lookup, same pattern as
 * src/tax/methods/index.ts's `resolveMethod`, so a raw jurisdiction value
 * never reaches a switch/ORDER BY.
 */
import { TaxJurisdiction } from '@prisma/client'
import { TaxProfile } from './types'
import { usProfile } from './us'
import { ukProfile } from './uk'
import { deProfile } from './de'
import { auProfile } from './au'
import { caProfile } from './ca'

const PROFILES: Record<TaxJurisdiction, TaxProfile> = {
  US: usProfile,
  UK: ukProfile,
  DE: deProfile,
  AU: auProfile,
  CA: caProfile,
}

export function resolveJurisdiction(jurisdiction: TaxJurisdiction): TaxProfile {
  const resolved = PROFILES[jurisdiction]
  if (!resolved) {
    throw new Error(`Unknown tax jurisdiction: ${jurisdiction}`)
  }
  return resolved
}

/** A `taxYear` label that is not a valid tax year for the jurisdiction (#844). */
export class TaxYearLabelError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TaxYearLabelError'
  }
}

/**
 * #844 — turns a tax-year label into the start year `taxYearFor` takes.
 * Labels are the profile's own canonical form: "2025" where the tax year is
 * the calendar year (US/DE/CA), "2025-26" where it spans two (UK/AU). A bare
 * "2025" is rejected for UK/AU, since it could mean either tax year that
 * touches 2025.
 */
export function parseTaxYearLabel(profile: TaxProfile, label: string): number {
  const trimmed = label.trim()
  const match = /^(\d{4})(?:-\d{2})?$/.exec(trimmed)
  const startYear = match ? Number(match[1]) : NaN
  const canonical = match
    ? profile.taxYearFor(new Date(Date.UTC(startYear, 0, 1)), startYear).label
    : null
  if (canonical === null || canonical !== trimmed) {
    const example = profile.taxYearFor(
      new Date(Date.UTC(2025, 0, 1)),
      2025
    ).label
    throw new TaxYearLabelError(
      `'${label}' is not a ${profile.displayName} tax year. Use the form '${example}'` +
        (canonical ? `; did you mean '${canonical}'?` : '.')
    )
  }
  return startYear
}

/** True when the profile's tax year spans two calendar years (UK, AU). */
export function isSplitTaxYear(profile: TaxProfile): boolean {
  return (
    profile.taxYearFor(new Date(Date.UTC(2025, 0, 1)), 2025).label !== '2025'
  )
}

export * from './types'
