// #844 — tax-year labels are explicit per jurisdiction: a calendar-year
// profile takes "2025", a split-year profile (UK, AU) takes "2025-26", and a
// bare year that could mean two UK/AU tax years is rejected.
import {
  isSplitTaxYear,
  parseTaxYearLabel,
  resolveJurisdiction,
  TaxYearLabelError,
} from '../../../src/tax/jurisdictions'

const uk = resolveJurisdiction('UK' as any)
const au = resolveJurisdiction('AU' as any)
const us = resolveJurisdiction('US' as any)
const de = resolveJurisdiction('DE' as any)

describe('parseTaxYearLabel', () => {
  it('maps a split-year label to the year the tax year starts in', () => {
    expect(parseTaxYearLabel(uk, '2025-26')).toBe(2025)
    expect(parseTaxYearLabel(au, '2025-26')).toBe(2025)
    expect(parseTaxYearLabel(uk, '1999-00')).toBe(1999)
  })

  it('maps a calendar-year label to that year', () => {
    expect(parseTaxYearLabel(us, '2025')).toBe(2025)
    expect(parseTaxYearLabel(de, ' 2025 ')).toBe(2025)
  })

  it('rejects a bare year for a split-year jurisdiction and suggests the label', () => {
    expect(() => parseTaxYearLabel(uk, '2025')).toThrow(TaxYearLabelError)
    expect(() => parseTaxYearLabel(uk, '2025')).toThrow(
      /did you mean '2025-26'/
    )
  })

  it('rejects a split label for a calendar-year jurisdiction', () => {
    expect(() => parseTaxYearLabel(us, '2025-26')).toThrow(
      /did you mean '2025'/
    )
  })

  it('rejects a split label whose second half does not follow the first', () => {
    expect(() => parseTaxYearLabel(au, '2025-27')).toThrow(TaxYearLabelError)
    expect(() => parseTaxYearLabel(au, 'FY2025')).toThrow(
      /Use the form '2025-26'/
    )
  })
})

describe('isSplitTaxYear', () => {
  it('is true only for UK and AU', () => {
    expect(isSplitTaxYear(uk)).toBe(true)
    expect(isSplitTaxYear(au)).toBe(true)
    expect(isSplitTaxYear(us)).toBe(false)
    expect(isSplitTaxYear(de)).toBe(false)
  })
})
