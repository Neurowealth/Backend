/**
 * German tax profile (#356). Calendar-year (UTC), same as US. Germany's
 * private-sale (`Privates Veräußerungsgeschäft`, §23 EStG) rule exempts a
 * disposal entirely once the asset was held for more than one year — modeled
 * as FULL_EXEMPTION at the 1-year threshold, distinct from the US's rate
 * split (this is an exemption, not a lower rate) and from AU's partial
 * discount. No wash-sale-style loss matching, no flat allowance (Germany's
 * per-transaction €600 exemption for private sales is a separate de-minimis
 * concept, out of scope here — see Known limitations).
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

export const deProfile: TaxProfile = {
  jurisdiction: TaxJurisdiction.DE,
  displayName: 'Germany',
  taxYearFor,
  holdingPeriod: {
    longTermThresholdDays: 366,
    longTermEffect: { kind: 'FULL_EXEMPTION' },
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
