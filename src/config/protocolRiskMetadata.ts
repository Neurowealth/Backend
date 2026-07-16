/**
 * Curated protocol risk metadata.
 *
 * This file is the single, reviewable source of truth for the two risk inputs
 * that cannot be derived from on-chain rate history: a protocol's audit status
 * and its age. On-chain data alone can't tell you whether a protocol has been
 * third-party audited or when it launched, so these are curated by hand.
 *
 * ── Review process (see docs/PROTOCOL_RISK_SCORING.md) ──────────────────────
 * This metadata goes stale (a protocol gets audited after being marked
 * UNAUDITED, or simply ages). It MUST be reviewed on protocol onboarding and
 * at least quarterly:
 *   1. Confirm `auditStatus` against the protocol's latest published audits.
 *      THIRD_PARTY_AUDITED requires a completed audit by a reputable external
 *      firm whose report is publicly linkable (record it in `auditReference`).
 *   2. `inceptionDate` is fixed at launch and should not change once set.
 *      protocolAgeDays is derived from it at compute time, so age stays current
 *      automatically without edits here.
 * Changes to this file are code-reviewed like any other change — that review IS
 * the update process. Do not move this data into a database or bury it in the
 * scoring code; keeping it explicit and diffable is the point.
 *
 * A protocol that appears in rate history but is absent here is treated as
 * UNAUDITED with unknown (0-day) age — the most conservative assumption.
 */

export type AuditStatusValue = 'UNAUDITED' | 'SELF_REPORTED' | 'THIRD_PARTY_AUDITED';

export interface ProtocolRiskMetadata {
  /** Must match ProtocolRate.protocolName / YieldProtocol.name exactly. */
  protocolName: string;
  auditStatus: AuditStatusValue;
  /**
   * Protocol launch date (ISO-8601, UTC). protocolAgeDays is computed from this
   * relative to the scoring run, so it never needs manual bumping.
   */
  inceptionDate: string;
  /** Optional public link/citation backing the auditStatus. For review only. */
  auditReference?: string;
}

/**
 * Curated metadata for the protocols the scanner tracks today (Blend, Stellar
 * DEX, Luma — see src/agent/scanner.ts). Add an entry when a new protocol is
 * onboarded to the scanner.
 *
 * NOTE: audit statuses below are placeholders pending verification against each
 * protocol's published audits (see the review process above). They intentionally
 * default toward the conservative end until confirmed.
 */
export const PROTOCOL_RISK_METADATA: readonly ProtocolRiskMetadata[] = [
  {
    protocolName: 'Blend',
    auditStatus: 'THIRD_PARTY_AUDITED',
    inceptionDate: '2024-02-01',
    auditReference: 'https://docs.blend.capital/ — verify latest audit report on review',
  },
  {
    protocolName: 'Stellar DEX',
    auditStatus: 'THIRD_PARTY_AUDITED',
    inceptionDate: '2015-09-30',
    auditReference: 'Stellar Core protocol; native DEX. Verify scope on review.',
  },
  {
    protocolName: 'Luma',
    auditStatus: 'SELF_REPORTED',
    inceptionDate: '2023-06-01',
    auditReference: 'Self-reported; no third-party audit confirmed at time of curation.',
  },
];

const METADATA_BY_NAME: ReadonlyMap<string, ProtocolRiskMetadata> = new Map(
  PROTOCOL_RISK_METADATA.map((m) => [m.protocolName, m]),
);

/**
 * The conservative default applied to any protocol seen in rate history but not
 * present in the curated table: unaudited, unknown age.
 */
export const DEFAULT_PROTOCOL_METADATA: Omit<ProtocolRiskMetadata, 'protocolName'> = {
  auditStatus: 'UNAUDITED',
  inceptionDate: '', // empty => age unknown => treated as 0 days (newest/riskiest)
};

/**
 * Look up curated metadata for a protocol, falling back to the conservative
 * default when the protocol is not curated.
 */
export function getProtocolMetadata(protocolName: string): ProtocolRiskMetadata {
  const found = METADATA_BY_NAME.get(protocolName);
  if (found) return found;
  return { protocolName, ...DEFAULT_PROTOCOL_METADATA };
}

/**
 * Compute protocol age in whole days from its curated inception date relative to
 * `now`. Returns 0 when the inception date is missing or unparseable (unknown
 * age is treated as brand-new, i.e. maximally risky).
 */
export function computeProtocolAgeDays(inceptionDate: string, now: Date): number {
  if (!inceptionDate) return 0;
  const inception = new Date(inceptionDate);
  const ms = inception.getTime();
  if (Number.isNaN(ms)) return 0;
  const diffMs = now.getTime() - ms;
  if (diffMs <= 0) return 0;
  return Math.floor(diffMs / (24 * 60 * 60 * 1000));
}
