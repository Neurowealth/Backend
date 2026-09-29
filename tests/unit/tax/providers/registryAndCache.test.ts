import { Decimal } from '@prisma/client/runtime/library'
import {
  PriceFeedCache,
  getPriceFeedProvider,
  setPriceFeedProvider,
  resetPriceFeedProvider,
  registerPriceFeedProvider,
  MockPriceFeedProvider,
  StellarDexPriceFeedProvider,
} from '../../../../src/tax/providers'

describe('PriceFeedCache and Registry', () => {
  beforeEach(() => {
    resetPriceFeedProvider()
  })

  afterEach(() => {
    resetPriceFeedProvider()
  })

  describe('PriceFeedCache', () => {
    it('stores and retrieves cached price entries by asset and date', () => {
      const cache = new PriceFeedCache(10)
      const date = new Date('2026-03-01T00:00:00Z')
      const entry = {
        price: new Decimal('0.15'),
        confidence: 'HIGH' as const,
        granularity: 'DAILY_CLOSE' as const,
        asOfDate: date,
        caveat: null,
        sourceName: 'test',
      }

      cache.set('XLM', entry, date)
      const retrieved = cache.get('XLM', date)

      expect(retrieved).not.toBeNull()
      expect(retrieved?.price.toString()).toBe('0.15')
    })

    it('expires entries when TTL elapsed', () => {
      const cache = new PriceFeedCache(10)
      const date = new Date('2026-03-01T00:00:00Z')
      const entry = {
        price: new Decimal('0.15'),
        confidence: 'HIGH' as const,
        granularity: 'DAILY_CLOSE' as const,
        asOfDate: date,
        caveat: null,
        sourceName: 'test',
      }

      cache.set('XLM', entry, date, -1000)
      const retrieved = cache.get('XLM', date)

      expect(retrieved).toBeNull()
    })

    it('evicts oldest entries when capacity exceeds maxEntries', () => {
      const cache = new PriceFeedCache(2)

      cache.set('ASSET1', {
        price: new Decimal(1),
        confidence: 'HIGH',
        granularity: 'SPOT',
        asOfDate: new Date(),
        caveat: null,
        sourceName: 'test',
      })

      cache.set('ASSET2', {
        price: new Decimal(2),
        confidence: 'HIGH',
        granularity: 'SPOT',
        asOfDate: new Date(),
        caveat: null,
        sourceName: 'test',
      })

      cache.set('ASSET3', {
        price: new Decimal(3),
        confidence: 'HIGH',
        granularity: 'SPOT',
        asOfDate: new Date(),
        caveat: null,
        sourceName: 'test',
      })

      expect(cache.size()).toBe(2)
      expect(cache.get('ASSET1')).toBeNull()
      expect(cache.get('ASSET2')).not.toBeNull()
      expect(cache.get('ASSET3')).not.toBeNull()
    })
  })

  describe('Provider Registry', () => {
    it('defaults to mock provider in test environment', () => {
      const provider = getPriceFeedProvider()
      expect(provider.name).toBe('mock')
    })

    it('resolves registered stellar-dex provider by name', () => {
      const provider = getPriceFeedProvider('stellar-dex')
      expect(provider.name).toBe('stellar-dex')
      expect(provider).toBeInstanceOf(StellarDexPriceFeedProvider)
    })

    it('supports custom provider overrides via setPriceFeedProvider', () => {
      const customMock = new MockPriceFeedProvider()
      customMock.seedPrice('CUSTOM', '42.00')

      setPriceFeedProvider(customMock)
      const active = getPriceFeedProvider()

      expect(active).toBe(customMock)
    })

    it('throws when requesting unregistered provider name', () => {
      expect(() => getPriceFeedProvider('unknown-provider')).toThrow(
        'Unknown price feed provider: "unknown-provider"'
      )
    })

    it('registers and resolves custom provider instance', () => {
      const custom = {
        name: 'custom-feed',
        getPrice: jest.fn().mockResolvedValue(null),
      }

      registerPriceFeedProvider(custom)
      const retrieved = getPriceFeedProvider('custom-feed')

      expect(retrieved.name).toBe('custom-feed')
    })
  })
})
