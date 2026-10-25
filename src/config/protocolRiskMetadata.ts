/**
 * Sourced, reviewable protocol risk metadata (#529).
 *
 * Source of truth is now the DB-backed ProtocolRiskMetadataEntry model
 * (sourceUrl, reviewedBy, nextReviewDueAt, dataConfidence) — see
 * docs/PROTOCOL_RISK_SCORING.md for the supersession of this file's
 * previous "keep it in-code, not a database" design note. The gap that
 * motivated the move: a code-reviewed diff shows WHAT changed, never
 * WHETHER it was verified against a source or WHEN it needs re-review.
 *
 * getProtocolMetadata stays SYNCHRONOUS and reads an in-process cache
 * rather than the DB directly: its sole caller, computeRiskScore
 * (src/agent/riskScoring.ts), is a deliberately pure, synchronous function
 * ("now" injected for deterministic tests) and making this async would
 * force that purity contract to break. refreshMetadataCache() is the
 * async entry point that populates the cache — called at startup and
 * after every admin write (src/config/riskMetadataAdmin.ts).
 *
 * A protocol with no cached entry is treated as UNAUDITED with unknown
 * (0-day) age — the most conservative assumption, matching the existing
 * fail-closed contract for a protocol with no ProtocolRiskScore row.
 */
import db from '../db'

export type AuditStatusValue =
  'UNAUDITED' | 'SELF_REPORTED' | 'THIRD_PARTY_AUDITED'

export interface ProtocolRiskMetadata {
  /** Must match ProtocolRate.protocolName / YieldProtocol.name exactly. */
  protocolName: string
  auditStatus: AuditStatusValue
  /**
   * Protocol launch date (ISO-8601, UTC). protocolAgeDays is computed from this
   * relative to the scoring run, so it never needs manual bumping.
   */
  inceptionDate: string
  /** Optional public link/citation backing the auditStatus. For review only. */
  auditReference?: string
}

/**
 * The conservative default applied to any protocol seen in rate history but
 * not present in the metadata table: unaudited, unknown age.
 */
export const DEFAULT_PROTOCOL_METADATA: Omit<
  ProtocolRiskMetadata,
  'protocolName'
> = {
  auditStatus: 'UNAUDITED',
  inceptionDate: '', // empty => age unknown => treated as 0 days (newest/riskiest)
}

/**
 * Historical reference only — the exact values that were live in this file
 * before #529 moved the source of truth to the DB. Used solely by the seed
 * regression test (tests/unit/config/protocolRiskMetadata-seed.test.ts) to
 * prove the migration's seed rows reproduce them exactly. Never read by
 * getProtocolMetadata or any runtime code path.
 */
export const PROTOCOL_RISK_METADATA: readonly ProtocolRiskMetadata[] = [
  {
    protocolName: 'Blend',
    auditStatus: 'THIRD_PARTY_AUDITED',
    inceptionDate: '2024-02-01',
    auditReference:
      'https://docs.blend.capital/ — verify latest audit report on review',
  },
  {
    protocolName: 'Stellar DEX',
    auditStatus: 'THIRD_PARTY_AUDITED',
    inceptionDate: '2015-09-30',
    auditReference:
      'Stellar Core protocol; native DEX. Verify scope on review.',
  },
  {
    protocolName: 'Luma',
    auditStatus: 'SELF_REPORTED',
    inceptionDate: '2023-06-01',
    auditReference:
      'Self-reported; no third-party audit confirmed at time of curation.',
  },
]

let cache = new Map<string, ProtocolRiskMetadata>()

/** Clears the in-process cache without repopulating it — test/reset use only. */
export function invalidateMetadataCache(): void {
  cache = new Map()
}

/**
 * Directly seeds the in-process cache without a DB round-trip — for unit
 * tests that exercise pure consumers of getProtocolMetadata (e.g.
 * computeRiskScore) without mocking the database. Never call from
 * production code; use refreshMetadataCache() there.
 */
export function seedMetadataCache(
  entries: readonly ProtocolRiskMetadata[]
): void {
  cache = new Map(entries.map((e) => [e.protocolName, e]))
}

/**
 * Repopulates the in-process cache from the DB. Call at startup and after
 * every admin write to ProtocolRiskMetadataEntry — this module never reads
 * the DB on its own, so a cache never refreshed stays at its last-known
 * (or default-conservative, if never refreshed) values.
 */
export async function refreshMetadataCache(): Promise<void> {
  const entries = await db.protocolRiskMetadataEntry.findMany()
  const next = new Map<string, ProtocolRiskMetadata>()
  for (const entry of entries) {
    next.set(entry.protocolName, {
      protocolName: entry.protocolName,
      auditStatus: entry.auditStatus,
      inceptionDate: entry.inceptionDate.toISOString(),
      auditReference: entry.auditReference,
    })
  }
  cache = next
}

/**
 * Look up cached metadata for a protocol, falling back to the conservative
 * default when the protocol has no entry (or the cache was never refreshed).
 */
export function getProtocolMetadata(
  protocolName: string
): ProtocolRiskMetadata {
  const found = cache.get(protocolName)
  if (found) return found
  return { protocolName, ...DEFAULT_PROTOCOL_METADATA }
}

/**
 * Compute protocol age in whole days from its curated inception date relative to
 * `now`. Returns 0 when the inception date is missing or unparseable (unknown
 * age is treated as brand-new, i.e. maximally risky).
 */
export function computeProtocolAgeDays(
  inceptionDate: string,
  now: Date
): number {
  if (!inceptionDate) return 0
  const inception = new Date(inceptionDate)
  const ms = inception.getTime()
  if (Number.isNaN(ms)) return 0
  const diffMs = now.getTime() - ms
  if (diffMs <= 0) return 0
  return Math.floor(diffMs / (24 * 60 * 60 * 1000))
}
