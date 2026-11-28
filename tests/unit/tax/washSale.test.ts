import { TaxJurisdiction } from '@prisma/client'
import {
  getWashSaleWindowDays,
  hasWashSaleRisk,
  washSaleWindowFor,
  type WashSaleRiskInput,
} from '../../../src/tax/washSale'

const DISPOSAL_DATE = new Date('2026-11-23T12:00:00.000Z')
const DAY_MS = 24 * 60 * 60 * 1000

function input(overrides: Partial<WashSaleRiskInput> = {}): WashSaleRiskInput {
  return {
    assetSymbol: 'USDC',
    disposalDate: DISPOSAL_DATE,
    jurisdiction: TaxJurisdiction.US,
    isLoss: true,
    acquisitionDates: [new Date(DISPOSAL_DATE.getTime() - 10 * DAY_MS)],
    ...overrides,
  }
}

describe('washSaleWindowFor', () => {
  it.each([TaxJurisdiction.DE, TaxJurisdiction.AU])(
    'returns null for %s, which has no loss-matching rule',
    (jurisdiction) => {
      expect(washSaleWindowFor(jurisdiction)).toBeNull()
      expect(getWashSaleWindowDays(jurisdiction)).toBe(0)
    }
  )

  it.each([
    [TaxJurisdiction.US, 30],
    [TaxJurisdiction.UK, 30],
    [TaxJurisdiction.CA, 30],
  ])('derives %s windowDays from its tax profile', (jurisdiction, days) => {
    expect(washSaleWindowFor(jurisdiction)).toMatchObject({
      windowDays: days,
      windowMs: days * DAY_MS,
    })
  })
})

describe('hasWashSaleRisk (#788)', () => {
  it.each([TaxJurisdiction.DE, TaxJurisdiction.AU])(
    'returns false for %s even with a loss and an in-window acquisition',
    (jurisdiction) => {
      expect(hasWashSaleRisk(input({ jurisdiction }))).toBe(false)
    }
  )

  it('returns false for a disposal at a gain', () => {
    expect(hasWashSaleRisk(input({ isLoss: false }))).toBe(false)
  })

  it('returns true for a US loss with a buy 10 days earlier', () => {
    expect(hasWashSaleRisk(input())).toBe(true)
  })

  it('returns true for an acquisition 10 days after the disposal', () => {
    expect(
      hasWashSaleRisk(
        input({
          acquisitionDates: [new Date(DISPOSAL_DATE.getTime() + 10 * DAY_MS)],
        })
      )
    ).toBe(true)
  })

  it('returns false for an acquisition outside the window', () => {
    expect(
      hasWashSaleRisk(
        input({
          acquisitionDates: [new Date(DISPOSAL_DATE.getTime() - 31 * DAY_MS)],
        })
      )
    ).toBe(false)
  })

  it('treats the 30-day boundary as inside the window', () => {
    expect(
      hasWashSaleRisk(
        input({
          acquisitionDates: [new Date(DISPOSAL_DATE.getTime() - 30 * DAY_MS)],
        })
      )
    ).toBe(true)
  })

  it('returns false when there is no actual same-asset acquisition', () => {
    expect(hasWashSaleRisk(input({ acquisitionDates: [] }))).toBe(false)
  })

  it('returns true when any of several acquisitions is inside the window', () => {
    expect(
      hasWashSaleRisk(
        input({
          acquisitionDates: [
            new Date(DISPOSAL_DATE.getTime() - 90 * DAY_MS),
            new Date(DISPOSAL_DATE.getTime() - 2 * DAY_MS),
          ],
        })
      )
    ).toBe(true)
  })
})
