import { safeEqual } from '../../../src/utils/safeCompare'

describe('safeEqual', () => {
  it('returns true for equal strings', () => {
    expect(safeEqual('super-secret-token', 'super-secret-token')).toBe(true)
  })

  it('returns false for unequal strings', () => {
    expect(safeEqual('super-secret-token', 'wrong-secret-token')).toBe(false)
  })

  it('returns false for different length strings', () => {
    expect(safeEqual('short', 'much-longer-secret')).toBe(false)
  })

  it('returns false for undefined inputs', () => {
    expect(safeEqual(undefined, 'secret')).toBe(false)
    expect(safeEqual('secret', undefined)).toBe(false)
    expect(safeEqual(undefined, undefined)).toBe(false)
  })

  it('returns false for null/non-string inputs', () => {
    expect(safeEqual(null, 'secret')).toBe(false)
    expect(safeEqual('secret', null)).toBe(false)
    expect(safeEqual(123 as any, '123')).toBe(false)
  })
})
