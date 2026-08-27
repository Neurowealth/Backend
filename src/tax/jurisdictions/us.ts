/**
 * US tax profile (#356). Calendar-year (UTC), long/short split at 1 year with
 * no discount (short/long are reported separately, each at ordinary/
 * different rates outside this system's scope), no flat annual allowance,
 * IRS Form 8949 / Schedule D / TXF export. This mirrors the pre-#356
 * hard-coded behavior in src/tax/report.ts byte-for-byte, so US reports are
 * unchanged.
 */
import { TaxJurisdiction } from '@prisma/client'
import { TaxProfile, TaxYearBoundary } from './types'

function taxYearFor(_forDate: Date, taxYearLabel: number): TaxYearBoundary {
  return {
    start: new Date(Date.UTC(taxYearLabel, 0, 1)),
    end: new Date(Date.UTC(taxYearLabel + 1, 0, 1)),
    label: String(taxYearLabel),
  }
}

export const usProfile: TaxProfile = {
  jurisdiction: TaxJurisdiction.US,
  displayName: 'United States',
  taxYearFor,
  holdingPeriod: {
    longTermThresholdDays: 366,
    longTermEffect: { kind: 'RATE_SPLIT' },
  },
  lossMatching: {
    kind: 'US_WASH_SALE',
    windowDays: 30,
  },
  allowance: {
    annualExemptAmount: '0',
  },
  exportFormat: 'US_8949_TXF',
}
