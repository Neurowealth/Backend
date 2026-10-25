import {
  deriveRiskBand,
  deriveProtocolsTouched,
} from '../../../src/strategy/marketplaceFacets'

describe('deriveRiskBand', () => {
  it('returns conservative for riskCeiling <= 30', () => {
    expect(deriveRiskBand(20)).toBe('conservative')
  })

  it('returns aggressive for riskCeiling >= 70', () => {
    expect(deriveRiskBand(80)).toBe('aggressive')
  })

  it('returns balanced for null riskCeiling', () => {
    expect(deriveRiskBand(null)).toBe('balanced')
  })

  it('returns balanced for undefined riskCeiling', () => {
    expect(deriveRiskBand(undefined)).toBe('balanced')
  })

  it('returns balanced for a mid-range riskCeiling', () => {
    expect(deriveRiskBand(50)).toBe('balanced')
  })
})

describe('deriveProtocolsTouched', () => {
  it('returns the keys of targetAllocations', () => {
    expect(deriveProtocolsTouched({ Blend: 60, 'Stellar DEX': 40 })).toEqual([
      'Blend',
      'Stellar DEX',
    ])
  })

  it('returns empty array when undefined', () => {
    expect(deriveProtocolsTouched(undefined)).toEqual([])
  })
})
