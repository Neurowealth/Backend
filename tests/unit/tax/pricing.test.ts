import { Decimal } from '@prisma/client/runtime/library'
import { lookupFeedPrice, priceForAsset } from '../../../src/tax/pricing'
import {
  defaultPriceCache,
  MockPriceFeedProvider,
  setPriceFeedProvider,
  resetPriceFeedProvider,
} from '../../../src/tax/providers'
import { evaluateTaxLossHarvest } from '../../../src/tax/washSale'

describe('Tax Pricing Engine', () => {
  let mockProvider: MockPriceFeedProvider

  beforeEach(() => {
    defaultPriceCache.clear()
    resetPriceFeedProvider()
    mockProvider = new MockPriceFeedProvider()
    setPriceFeedProvider(mockProvider)
  })

  afterEach(() => {
    defaultPriceCache.clear()
    resetPriceFeedProvider()
  })

  describe('lookupFeedPrice', () => {
    it('resolves historical price from market feed for non-stablecoin asset', async () => {
      const historicalDate = new Date('2026-03-15T12:00:00Z')
      mockProvider.seedPrice('XLM', '0.125', {
        asOfDate: historicalDate,
        confidence: 'HIGH',
        granularity: 'DAILY_CLOSE',
      })

      const result = await lookupFeedPrice('XLM', historicalDate)

      expect(result).not.toBeNull()
      expect(result?.price.toString()).toBe('0.125')
      expect(result?.confidence).toBe('HIGH')
      expect(result?.granularity).toBe('DAILY_CLOSE')
      expect(result?.asOfDate).toEqual(historicalDate)
      expect(result?.caveat).toBeNull()
    })

    it('returns null when feed has no historical data for the requested date', async () => {
      const unseededDate = new Date('2025-01-01T00:00:00Z')

      const result = await lookupFeedPrice('XLM', unseededDate)

      expect(result).toBeNull()
    })

    it('gracefully degrades to null during feed outages without throwing', async () => {
      mockProvider.setOutage(true)

      const result = await lookupFeedPrice('XLM', new Date())

      expect(result).toBeNull()
    })

    it('flags low confidence and provides caveat for thin liquidity or stale quotes', async () => {
      const historicalDate = new Date('2026-02-10T08:00:00Z')
      mockProvider.seedPrice('XLM', '0.118', {
        asOfDate: historicalDate,
        confidence: 'LOW',
        granularity: 'DAILY_CLOSE',
        caveat:
          'Thin trading volume on Stellar DEX for date; price may exhibit elevated variance',
      })

      const result = await lookupFeedPrice('XLM', historicalDate)

      expect(result).not.toBeNull()
      expect(result?.price.toString()).toBe('0.118')
      expect(result?.confidence).toBe('LOW')
      expect(result?.caveat).toContain('Thin trading volume')
    })

    it('uses bounded-TTL cache for subsequent requests to avoid redundant provider calls', async () => {
      const targetDate = new Date('2026-04-01T00:00:00Z')
      mockProvider.seedPrice('XLM', '0.150', { asOfDate: targetDate })

      const firstCall = await lookupFeedPrice('XLM', targetDate)
      expect(firstCall?.price.toString()).toBe('0.15')

      mockProvider.clear()

      const secondCall = await lookupFeedPrice('XLM', targetDate)
      expect(secondCall?.price.toString()).toBe('0.15')

      defaultPriceCache.clear()

      const thirdCall = await lookupFeedPrice('XLM', targetDate)
      expect(thirdCall).toBeNull()
    })
  })

  describe('priceForAsset hierarchy', () => {
    it('prioritizes user-declared price over market feed and stablecoin assumptions', async () => {
      const date = new Date('2026-05-01T00:00:00Z')
      mockProvider.seedPrice('USDC', '1.05', { asOfDate: date })

      const result = await priceForAsset('USDC', {
        userDeclaredPrice: '0.99',
        asOfDate: date,
      })

      expect(result.source).toBe('USER_DECLARED')
      expect(result.price?.toString()).toBe('0.99')
      expect(result.confidence).toBe('HIGH')
    })

    it('resolves market feed price for non-stablecoin asset when available', async () => {
      const date = new Date('2026-05-10T00:00:00Z')
      mockProvider.seedPrice('XLM', '0.134', {
        asOfDate: date,
        confidence: 'HIGH',
      })

      const result = await priceForAsset('XLM', { asOfDate: date })

      expect(result.source).toBe('MARKET_FEED')
      expect(result.price?.toString()).toBe('0.134')
      expect(result.confidence).toBe('HIGH')
      expect(result.caveat).toBeNull()
    })

    it('applies stablecoin assumption 1.00 USD for USDC when unpriced by feed', async () => {
      const result = await priceForAsset('USDC')

      expect(result.source).toBe('STABLECOIN_ASSUMPTION')
      expect(result.price?.toString()).toBe('1')
      expect(result.confidence).toBe('HIGH')
    })

    it('leaves unpriced asset honestly null with descriptive caveat metadata', async () => {
      const historicalDate = new Date('2024-01-01T00:00:00Z')
      const result = await priceForAsset('UNKNOWN_ASSET', {
        asOfDate: historicalDate,
      })

      expect(result.source).toBeNull()
      expect(result.price).toBeNull()
      expect(result.caveat).toBe(
        'Historical price unavailable from market feed for transaction timestamp'
      )
    })
  })

  describe('evaluateTaxLossHarvest', () => {
    it('calculates unrealized loss when current market price is below cost basis', async () => {
      const evalDate = new Date('2026-06-01T00:00:00Z')
      mockProvider.seedPrice('XLM', '0.10', { asOfDate: evalDate })

      const estimate = await evaluateTaxLossHarvest(
        'XLM',
        '1000',
        '0.15',
        evalDate
      )

      expect(estimate).not.toBeNull()
      expect(estimate?.isLoss).toBe(true)
      expect(estimate?.currentPrice.toString()).toBe('0.1')
      expect(estimate?.unrealizedLossTotal.toString()).toBe('50')
    })

    it('identifies no loss when market price is above cost basis', async () => {
      const evalDate = new Date('2026-06-01T00:00:00Z')
      mockProvider.seedPrice('XLM', '0.20', { asOfDate: evalDate })

      const estimate = await evaluateTaxLossHarvest(
        'XLM',
        '1000',
        '0.15',
        evalDate
      )

      expect(estimate).not.toBeNull()
      expect(estimate?.isLoss).toBe(false)
      expect(estimate?.unrealizedLossTotal.toString()).toBe('0')
    })

    it('returns null when asset price cannot be resolved', async () => {
      const estimate = await evaluateTaxLossHarvest('UNKNOWN', '100', '1.00')
      expect(estimate).toBeNull()
    })
  })
})
