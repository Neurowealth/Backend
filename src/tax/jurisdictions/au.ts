/**
 * Australian tax profile (#356). Tax year runs 1 July → 30 June (UTC-
 * anchored calendar date). The 50% CGT discount applies to gains on assets
 * held 12 months or more — modeled as FLAT_DISCOUNT, distinct from Germany's
 * full exemption. No wash-sale-style loss matching rule is modeled (the ATO's
 * "wash sale" guidance is an anti-avoidance general rule, not a mechanical
 * day-window test like the US/UK/CA rules), no flat annual allowance.
 */
import { TaxJurisdiction } from '@prisma/client'
import { TaxProfile, TaxYearBoundary } from './types'

const AU_TAX_YEAR_START_MONTH = 6 // July, 0-indexed

function taxYearFor(_forDate: Date, taxYearLabel: number): TaxYearBoundary {
  // `taxYearLabel` names the year the tax year *starts* in — AU FY2025-26
  // runs 2025-07-01 to 2026-06-30, taxYearLabel = 2025.
  const start = new Date(Date.UTC(taxYearLabel, AU_TAX_YEAR_START_MONTH, 1))
  const end = new Date(Date.UTC(taxYearLabel + 1, AU_TAX_YEAR_START_MONTH, 1))
  return {
    start,
    end,
    label: `${taxYearLabel}-${String((taxYearLabel + 1) % 100).padStart(2, '0')}`,
  }
}

export const auProfile: TaxProfile = {
  jurisdiction: TaxJurisdiction.AU,
  displayName: 'Australia',
  taxYearFor,
  holdingPeriod: {
    longTermThresholdDays: 365,
    longTermEffect: { kind: 'FLAT_DISCOUNT', discountPercent: 50 },
  },
  lossMatching: {
    kind: 'NONE',
    windowDays: 0,
  },
  allowance: {
    annualExemptAmount: '0',
  },
  exportFormat: 'GENERIC_CSV',
}
