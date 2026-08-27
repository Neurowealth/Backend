/**
 * Canadian tax profile (#356). Calendar-year (UTC), same as US. Canada taxes
 * capital gains at a 50% inclusion rate rather than a holding-period
 * discount — modeled as FLAT_DISCOUNT with no threshold (applies from day
 * one), which is mathematically the same "halve the taxable gain" shape as
 * AU's discount even though the underlying rule (inclusion rate vs.
 * holding-period discount) differs conceptually. Loss matching uses the
 * superficial-loss rule (30 days before/after, symmetric window like the US
 * wash sale but under different disallowance mechanics — see Known
 * limitations in docs/TAX_REPORT.md for what this profile does not model).
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

export const caProfile: TaxProfile = {
  jurisdiction: TaxJurisdiction.CA,
  displayName: 'Canada',
  taxYearFor,
  holdingPeriod: {
    longTermThresholdDays: 0,
    longTermEffect: { kind: 'FLAT_DISCOUNT', discountPercent: 50 },
  },
  lossMatching: {
    kind: 'CA_SUPERFICIAL_LOSS',
    windowDays: 30,
  },
  allowance: {
    annualExemptAmount: '0',
  },
  exportFormat: 'GENERIC_CSV',
}
