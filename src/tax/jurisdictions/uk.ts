/**
 * UK tax profile (#356). Tax year runs 6 April → 5 April (UTC-anchored on the
 * calendar date, not a local timezone). No long/short holding-period split —
 * UK CGT does not distinguish by holding period. Loss matching uses HMRC's
 * "same-day" and "30-day bed-and-breakfast" identification rules ahead of
 * pooled (section 104) cost basis — modeled here as one 30-day window rule;
 * the same-day case is the windowDays=0 boundary of the same check. £3,000
 * Annual Exempt Amount (2024/25 rate) is applied as a flat allowance against
 * total net gains.
 */
import { TaxJurisdiction } from '@prisma/client'
import { TaxProfile, TaxYearBoundary } from './types'

const UK_TAX_YEAR_START_MONTH = 3 // April, 0-indexed
const UK_TAX_YEAR_START_DAY = 6

function taxYearFor(_forDate: Date, taxYearLabel: number): TaxYearBoundary {
  // `taxYearLabel` names the year the tax year *starts* in — the 2025 UK tax
  // year runs 2025-04-06 to 2026-04-05, conventionally written "2025-26".
  const start = new Date(
    Date.UTC(taxYearLabel, UK_TAX_YEAR_START_MONTH, UK_TAX_YEAR_START_DAY)
  )
  const end = new Date(
    Date.UTC(taxYearLabel + 1, UK_TAX_YEAR_START_MONTH, UK_TAX_YEAR_START_DAY)
  )
  return {
    start,
    end,
    label: `${taxYearLabel}-${String((taxYearLabel + 1) % 100).padStart(2, '0')}`,
  }
}

export const ukProfile: TaxProfile = {
  jurisdiction: TaxJurisdiction.UK,
  displayName: 'United Kingdom',
  taxYearFor,
  holdingPeriod: {
    longTermThresholdDays: 0,
    longTermEffect: { kind: 'NONE' },
  },
  lossMatching: {
    kind: 'UK_BED_AND_BREAKFAST',
    windowDays: 30,
  },
  allowance: {
    annualExemptAmount: '3000',
  },
  exportFormat: 'GENERIC_CSV',
}
