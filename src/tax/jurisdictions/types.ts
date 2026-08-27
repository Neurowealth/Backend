/**
 * Per-jurisdiction tax profile (#356).
 *
 * A declarative config of the rules that vary by country. The existing pure
 * cores (src/tax/methods/, src/tax/report.ts) stay method-of-cost-basis
 * concerns; a TaxProfile layers the jurisdiction-specific concerns on top —
 * which calendar the tax year uses, whether/how holding period changes
 * treatment, how losses are matched against near-in-time re-acquisitions, any
 * flat allowance, and which export format the report should offer. No
 * profile computes money itself; report.ts still does that from
 * LotDisposal — a profile only tells it which disposals belong to "this
 * year" and how to annotate/adjust them.
 */
import { TaxJurisdiction } from '@prisma/client'

export interface TaxYearBoundary {
  /** Inclusive UTC start of the tax year containing `forDate`. */
  start: Date
  /** Exclusive UTC end of the tax year containing `forDate`. */
  end: Date
  /** The label a report should show for this period, e.g. "2025" or "2025-26". */
  label: string
}

export interface HoldingPeriodRule {
  /** Calendar days held at/after which the long-term treatment applies. */
  longTermThresholdDays: number
  /**
   * What long-term treatment means for this jurisdiction. FIFO/LIFO/etc.
   * still decide *which* lot was sold; this only decides how a profile
   * wants that disposal's gain annotated/discounted once it's known.
   */
  longTermEffect:
    | { kind: 'NONE' } // e.g. UK — no long/short split at all
    | { kind: 'RATE_SPLIT' } // e.g. US — separate short/long summary, no discount
    | { kind: 'FLAT_DISCOUNT'; discountPercent: number } // e.g. AU 50% CGT discount
    | { kind: 'FULL_EXEMPTION' } // e.g. DE — exempt after the speculative period
}

export interface LossMatchingRule {
  /** e.g. US wash sale, UK same-day/30-day, CA superficial loss. */
  kind: 'NONE' | 'US_WASH_SALE' | 'UK_BED_AND_BREAKFAST' | 'CA_SUPERFICIAL_LOSS'
  /** Window, in days, a re-acquisition on either side of the loss disqualifies it. */
  windowDays: number
}

export interface AllowanceRule {
  /** Flat amount of gain exempt from tax each tax year, in the account's report currency (0 = none). */
  annualExemptAmount: string
}

export type TaxExportFormat = 'US_8949_TXF' | 'GENERIC_CSV'

export interface TaxProfile {
  readonly jurisdiction: TaxJurisdiction
  readonly displayName: string
  /** Given any instant, resolve the tax-year window it falls in. */
  taxYearFor(forDate: Date, taxYearLabel: number): TaxYearBoundary
  readonly holdingPeriod: HoldingPeriodRule
  readonly lossMatching: LossMatchingRule
  readonly allowance: AllowanceRule
  readonly exportFormat: TaxExportFormat
}
