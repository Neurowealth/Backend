/**
 * FX conversion utility tests (#534).
 */

import {
  convertUsdToCurrency,
  getSupportedCurrencies,
  isCurrencySupported,
  withDisplayCurrency,
} from '../../../src/utils/fxConvert'

describe('src/utils/fxConvert', () => {
  describe('getSupportedCurrencies', () => {
    it('returns a non-empty list including USD', () => {
      const currencies = getSupportedCurrencies()
      expect(currencies).toContain('USD')
      expect(currencies.length).toBeGreaterThan(5)
    })
  })

  describe('isCurrencySupported', () => {
    it('returns true for supported currencies', () => {
      expect(isCurrencySupported('USD')).toBe(true)
      expect(isCurrencySupported('EUR')).toBe(true)
      expect(isCurrencySupported('GBP')).toBe(true)
    })

    it('returns false for unsupported currencies', () => {
      expect(isCurrencySupported('XYZ')).toBe(false)
      expect(isCurrencySupported('')).toBe(false)
    })
  })

  describe('convertUsdToCurrency', () => {
    it('returns the same amount for USD', () => {
      expect(convertUsdToCurrency(100, 'USD')).toBe(100)
    })

    it('converts to EUR correctly', () => {
      const result = convertUsdToCurrency(100, 'EUR')
      expect(result).not.toBeNull()
      expect(result!).toBeGreaterThan(0)
      expect(result!).toBeLessThan(100)
    })

    it('returns null for unsupported currency', () => {
      expect(convertUsdToCurrency(100, 'XYZ')).toBeNull()
    })

    it('rounds to 2 decimal places', () => {
      const result = convertUsdToCurrency(100, 'JPY')
      expect(result).not.toBeNull()
      const decimals = (result!.toString().split('.')[1] || '').length
      expect(decimals).toBeLessThanOrEqual(2)
    })

    it('handles zero amount', () => {
      expect(convertUsdToCurrency(0, 'EUR')).toBe(0)
    })
  })

  describe('withDisplayCurrency', () => {
    it('attaches displayAmount and displayCurrency', () => {
      const result = withDisplayCurrency({ amountUsd: 100 }, 'EUR')
      expect(result.displayCurrency).toBe('EUR')
      expect(result.displayAmount).toBeDefined()
      expect(result.amountUsd).toBe(100)
    })

    it('omits displayAmount when currency unsupported', () => {
      const result = withDisplayCurrency({ amountUsd: 100 }, 'XYZ')
      expect(result.displayCurrency).toBe('XYZ')
      expect(result.displayAmount).toBeUndefined()
      expect(result.amountUsd).toBe(100)
    })

    it('preserves all original fields', () => {
      const result = withDisplayCurrency({ amountUsd: 100, name: 'test', id: '1' }, 'GBP')
      expect(result.name).toBe('test')
      expect(result.id).toBe('1')
      expect(result.amountUsd).toBe(100)
    })
  })
})
