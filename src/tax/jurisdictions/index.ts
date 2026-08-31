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

export * from './types'
