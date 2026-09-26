import { Decimal } from '@prisma/client/runtime/library'
import {
  priceForAsset,
  priceForAssetSync,
  lookupFeedPrice,
  lookupFeedPriceSync,
  getQuoteMetadata,
  clearPriceFeedCache,
  setPriceFeedAdapter,
  resetPriceFeedAdapter,
  PriceSource,
} from '../../../src/tax/pricing'
import {
  HorizonOrderbookAdapter,
  StellarExpertAdapter,
  HttpOracleAdapter,
  CompositePriceFeedAdapter,
  PriceFeedAdapter,
  PriceQuote,
} from '../../../src/tax/feedAdapter'
import * as fetchModule from '../../../src/utils/fetchWithRetry'
import * as redisModule from '../../../src/config/redis'

jest.mock('../../../src/utils/logger', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}))

describe('pricing source hierarchy (#444)', () => {
  beforeEach(async () => {
    jest.clearAllMocks()
    await clearPriceFeedCache()
    resetPriceFeedAdapter()
  })

  afterEach(async () => {
    await clearPriceFeedCache()
    resetPriceFeedAdapter()
  })

  describe('Level 1: user-declared pricing', () => {
    it('returns USER_DECLARED when userDeclaredPrice option is provided for volatile asset', async () => {
      const mockAdapter: PriceFeedAdapter = {
        name: 'MOCK_FEED',
        fetchPrice: jest.fn().mockResolvedValue({
          price: new Decimal('0.15'),
          source: 'MOCK_FEED',
          timestamp: new Date(),
        }),
      }
      setPriceFeedAdapter(mockAdapter)

      const result = await priceForAsset('XLM', { userDeclaredPrice: '0.25' })

      expect(result.source).toBe(PriceSource.USER_DECLARED)
      expect(result.price).toBeInstanceOf(Decimal)
      expect(result.price?.toString()).toBe('0.25')
      expect(mockAdapter.fetchPrice).not.toHaveBeenCalled()
    })

    it('returns USER_DECLARED even for USDC when userDeclaredPrice is explicitly provided', async () => {
      const result = await priceForAsset('USDC', { userDeclaredPrice: '0.99' })

      expect(result.source).toBe(PriceSource.USER_DECLARED)
      expect(result.price?.toString()).toBe('0.99')
    })

    it('supports userDeclaredPrice in synchronous priceForAssetSync', () => {
      const result = priceForAssetSync('XLM', { userDeclaredPrice: 0.35 })

      expect(result.source).toBe(PriceSource.USER_DECLARED)
      expect(result.price?.toString()).toBe('0.35')
    })
  })

  describe('Level 2: market feed pricing', () => {
    it('returns MARKET_FEED when feed adapter returns a quote', async () => {
      const quote: PriceQuote = {
        price: new Decimal('0.125'),
        source: 'HORIZON_ORDERBOOK',
        timestamp: new Date(),
        metadata: { bestBid: '0.124', bestAsk: '0.126' },
      }
      const mockAdapter: PriceFeedAdapter = {
        name: 'MOCK_FEED',
        fetchPrice: jest.fn().mockResolvedValue(quote),
      }
      setPriceFeedAdapter(mockAdapter)

      const result = await priceForAsset('XLM')

      expect(result.source).toBe(PriceSource.MARKET_FEED)
      expect(result.price?.toString()).toBe('0.125')
      expect(mockAdapter.fetchPrice).toHaveBeenCalledWith('XLM')
    })

    it('caches quotes with TTL so subsequent calls do not query adapter again', async () => {
      const mockAdapter: PriceFeedAdapter = {
        name: 'MOCK_FEED',
        fetchPrice: jest.fn().mockResolvedValue({
          price: new Decimal('0.125'),
          source: 'MOCK_FEED',
          timestamp: new Date(),
        }),
      }
      setPriceFeedAdapter(mockAdapter)

      const first = await lookupFeedPrice('XLM')
      const second = await lookupFeedPrice('XLM')
      const third = await priceForAsset('XLM')

      expect(first?.toString()).toBe('0.125')
      expect(second?.toString()).toBe('0.125')
      expect(third.price?.toString()).toBe('0.125')
      expect(third.source).toBe(PriceSource.MARKET_FEED)
      expect(mockAdapter.fetchPrice).toHaveBeenCalledTimes(1)
    })

    it('persists and retrieves quote metadata in memory and Redis', async () => {
      const sampleDate = new Date('2026-09-26T00:00:00Z')
      const mockAdapter: PriceFeedAdapter = {
        name: 'MOCK_FEED',
        fetchPrice: jest.fn().mockResolvedValue({
          price: new Decimal('0.125'),
          source: 'MOCK_FEED',
          timestamp: sampleDate,
          metadata: { depth: 5000 },
        }),
      }
      setPriceFeedAdapter(mockAdapter)

      await priceForAsset('XLM')
      const meta = await getQuoteMetadata('XLM')

      expect(meta).not.toBeNull()
      expect(meta?.price.toString()).toBe('0.125')
      expect(meta?.source).toBe('MOCK_FEED')
      expect(meta?.timestamp).toEqual(sampleDate)
      expect(meta?.metadata).toEqual({ depth: 5000 })
    })

    it('serves cached price to synchronous lookupFeedPriceSync and priceForAssetSync', async () => {
      const mockAdapter: PriceFeedAdapter = {
        name: 'MOCK_FEED',
        fetchPrice: jest.fn().mockResolvedValue({
          price: new Decimal('0.125'),
          source: 'MOCK_FEED',
          timestamp: new Date(),
        }),
      }
      setPriceFeedAdapter(mockAdapter)

      expect(lookupFeedPriceSync('XLM')).toBeNull()
      expect(priceForAssetSync('XLM').price).toBeNull()

      await priceForAsset('XLM')

      expect(lookupFeedPriceSync('XLM')?.toString()).toBe('0.125')
      const syncResult = priceForAssetSync('XLM')
      expect(syncResult.source).toBe(PriceSource.MARKET_FEED)
      expect(syncResult.price?.toString()).toBe('0.125')
    })
  })

  describe('Level 3: USDC stablecoin assumption', () => {
    it('returns STABLECOIN_ASSUMPTION for USDC with price 1', async () => {
      const result = await priceForAsset('USDC')

      expect(result.source).toBe(PriceSource.STABLECOIN_ASSUMPTION)
      expect(result.price?.toString()).toBe('1')
    })

    it('always bypasses feed lookup for USDC', async () => {
      const mockAdapter: PriceFeedAdapter = {
        name: 'MOCK_FEED',
        fetchPrice: jest.fn().mockResolvedValue({
          price: new Decimal('0.98'),
          source: 'MOCK_FEED',
          timestamp: new Date(),
        }),
      }
      setPriceFeedAdapter(mockAdapter)

      const feedPrice = await lookupFeedPrice('USDC')
      const result = await priceForAsset('USDC')

      expect(feedPrice).toBeNull()
      expect(mockAdapter.fetchPrice).not.toHaveBeenCalled()
      expect(result.source).toBe(PriceSource.STABLECOIN_ASSUMPTION)
      expect(result.price?.toString()).toBe('1')
    })

    it('handles USDC case-insensitively in sync and async lookups', async () => {
      const lower = await priceForAsset('usdc')
      const syncLower = priceForAssetSync('usdc')

      expect(lower.source).toBe(PriceSource.STABLECOIN_ASSUMPTION)
      expect(lower.price?.toString()).toBe('1')
      expect(syncLower.source).toBe(PriceSource.STABLECOIN_ASSUMPTION)
      expect(syncLower.price?.toString()).toBe('1')
    })
  })

  describe('Level 4: honest unpriced fallback', () => {
    it('returns null price and null source when feed misses', async () => {
      const mockAdapter: PriceFeedAdapter = {
        name: 'MOCK_FEED',
        fetchPrice: jest.fn().mockResolvedValue(null),
      }
      setPriceFeedAdapter(mockAdapter)

      const result = await priceForAsset('UNKNOWN_TOKEN')

      expect(result.price).toBeNull()
      expect(result.source).toBeNull()
    })

    it('returns null on feed outage rather than fabricating zero', async () => {
      const mockAdapter: PriceFeedAdapter = {
        name: 'FAILING_FEED',
        fetchPrice: jest
          .fn()
          .mockRejectedValue(new Error('Horizon gateway 504')),
      }
      setPriceFeedAdapter(mockAdapter)

      const feedPrice = await lookupFeedPrice('XLM').catch(() => null)
      const result = await priceForAsset('XLM')

      expect(feedPrice).toBeNull()
      expect(result.price).toBeNull()
      expect(result.source).toBeNull()
    })
  })

  describe('HorizonOrderbookAdapter', () => {
    it('computes mid-market price from best bid and best ask', async () => {
      const spyFetch = jest
        .spyOn(fetchModule, 'fetchWithRetry')
        .mockResolvedValue({
          bids: [{ price: '0.1200000', amount: '1000' }],
          asks: [{ price: '0.1300000', amount: '1000' }],
        })

      const adapter = new HorizonOrderbookAdapter(
        'https://horizon-test.stellar.org'
      )
      const quote = await adapter.fetchPrice('XLM')

      expect(quote).not.toBeNull()
      expect(quote?.price.toString()).toBe('0.125')
      expect(quote?.source).toBe('HORIZON_ORDERBOOK')
      expect(quote?.metadata?.bestBid).toBe('0.1200000')
      expect(quote?.metadata?.bestAsk).toBe('0.1300000')

      spyFetch.mockRestore()
    })

    it('uses best bid when asks are empty', async () => {
      const spyFetch = jest
        .spyOn(fetchModule, 'fetchWithRetry')
        .mockResolvedValue({
          bids: [{ price: '0.1200000', amount: '1000' }],
          asks: [],
        })

      const adapter = new HorizonOrderbookAdapter()
      const quote = await adapter.fetchPrice('XLM')

      expect(quote?.price.toString()).toBe('0.12')
      spyFetch.mockRestore()
    })

    it('uses best ask when bids are empty', async () => {
      const spyFetch = jest
        .spyOn(fetchModule, 'fetchWithRetry')
        .mockResolvedValue({
          bids: [],
          asks: [{ price: '0.1300000', amount: '1000' }],
        })

      const adapter = new HorizonOrderbookAdapter()
      const quote = await adapter.fetchPrice('XLM')

      expect(quote?.price.toString()).toBe('0.13')
      spyFetch.mockRestore()
    })

    it('returns null on empty orderbook', async () => {
      const spyFetch = jest
        .spyOn(fetchModule, 'fetchWithRetry')
        .mockResolvedValue({
          bids: [],
          asks: [],
        })

      const adapter = new HorizonOrderbookAdapter()
      const quote = await adapter.fetchPrice('XLM')

      expect(quote).toBeNull()
      spyFetch.mockRestore()
    })

    it('correctly constructs query URL for custom issued asset CODE:ISSUER', async () => {
      let requestedUrl = ''
      const spyFetch = jest
        .spyOn(fetchModule, 'fetchWithRetry')
        .mockImplementation((url: string) => {
          requestedUrl = url
          return Promise.resolve({
            bids: [{ price: '2.50', amount: '100' }],
            asks: [{ price: '2.50', amount: '100' }],
          })
        })

      const adapter = new HorizonOrderbookAdapter()
      const quote = await adapter.fetchPrice(
        'AQUA:GBNZILSTVQZ4R7IKQDGHYGY2Q2KRN5SEF4ND755LMWDJXGGLQ776G6CC'
      )

      expect(quote?.price.toString()).toBe('2.5')
      expect(requestedUrl).toContain('selling_asset_type=credit_alphanum4')
      expect(requestedUrl).toContain('selling_asset_code=AQUA')
      expect(requestedUrl).toContain(
        'selling_asset_issuer=GBNZILSTVQZ4R7IKQDGHYGY2Q2KRN5SEF4ND755LMWDJXGGLQ776G6CC'
      )

      spyFetch.mockRestore()
    })

    it('returns null and logs warning on network failure', async () => {
      const spyFetch = jest
        .spyOn(fetchModule, 'fetchWithRetry')
        .mockRejectedValue(new Error('Connection timeout'))

      const adapter = new HorizonOrderbookAdapter()
      const quote = await adapter.fetchPrice('XLM')

      expect(quote).toBeNull()
      spyFetch.mockRestore()
    })
  })

  describe('StellarExpertAdapter', () => {
    it('parses valid numeric price from Stellar Expert API', async () => {
      const spyFetch = jest
        .spyOn(fetchModule, 'fetchWithRetry')
        .mockResolvedValue({
          asset: 'XLM',
          price: 0.128,
          supply: 50000000000,
        })

      const adapter = new StellarExpertAdapter(
        'https://api.stellar.expert/explorer/public'
      )
      const quote = await adapter.fetchPrice('XLM')

      expect(quote).not.toBeNull()
      expect(quote?.price.toString()).toBe('0.128')
      expect(quote?.source).toBe('STELLAR_EXPERT')

      spyFetch.mockRestore()
    })

    it('returns null on missing price attribute', async () => {
      const spyFetch = jest
        .spyOn(fetchModule, 'fetchWithRetry')
        .mockResolvedValue({
          asset: 'XLM',
          supply: 50000000000,
        })

      const adapter = new StellarExpertAdapter()
      const quote = await adapter.fetchPrice('XLM')

      expect(quote).toBeNull()
      spyFetch.mockRestore()
    })

    it('returns null on negative or zero price', async () => {
      const spyFetch = jest
        .spyOn(fetchModule, 'fetchWithRetry')
        .mockResolvedValue({
          asset: 'XLM',
          price: 0,
        })

      const adapter = new StellarExpertAdapter()
      const quote = await adapter.fetchPrice('XLM')

      expect(quote).toBeNull()
      spyFetch.mockRestore()
    })
  })

  describe('HttpOracleAdapter', () => {
    it('returns null when no oracle URL is configured', async () => {
      const adapter = new HttpOracleAdapter(undefined)
      const quote = await adapter.fetchPrice('XLM')

      expect(quote).toBeNull()
    })

    it('parses price from { price: 0.135 }', async () => {
      const spyFetch = jest
        .spyOn(fetchModule, 'fetchWithRetry')
        .mockResolvedValue({
          price: '0.135',
        })

      const adapter = new HttpOracleAdapter('https://oracle.example.com/rates')
      const quote = await adapter.fetchPrice('XLM')

      expect(quote?.price.toString()).toBe('0.135')
      expect(quote?.source).toBe('HTTP_ORACLE')
      spyFetch.mockRestore()
    })

    it('parses price from { usd: 0.135 }', async () => {
      const spyFetch = jest
        .spyOn(fetchModule, 'fetchWithRetry')
        .mockResolvedValue({
          usd: 0.135,
        })

      const adapter = new HttpOracleAdapter('https://oracle.example.com/rates')
      const quote = await adapter.fetchPrice('XLM')

      expect(quote?.price.toString()).toBe('0.135')
      spyFetch.mockRestore()
    })

    it('parses price from nested asset map { XLM: { price: 0.135 } }', async () => {
      const spyFetch = jest
        .spyOn(fetchModule, 'fetchWithRetry')
        .mockResolvedValue({
          XLM: { price: '0.135' },
        })

      const adapter = new HttpOracleAdapter('https://oracle.example.com/rates')
      const quote = await adapter.fetchPrice('XLM')

      expect(quote?.price.toString()).toBe('0.135')
      spyFetch.mockRestore()
    })
  })

  describe('CompositePriceFeedAdapter', () => {
    it('falls through from failed primary adapter to working secondary adapter', async () => {
      const primary: PriceFeedAdapter = {
        name: 'PRIMARY_FAIL',
        fetchPrice: jest.fn().mockResolvedValue(null),
      }
      const secondary: PriceFeedAdapter = {
        name: 'SECONDARY_OK',
        fetchPrice: jest.fn().mockResolvedValue({
          price: new Decimal('0.142'),
          source: 'SECONDARY_OK',
          timestamp: new Date(),
        }),
      }

      const composite = new CompositePriceFeedAdapter([primary, secondary])
      const quote = await composite.fetchPrice('XLM')

      expect(quote?.price.toString()).toBe('0.142')
      expect(quote?.source).toBe('SECONDARY_OK')
      expect(primary.fetchPrice).toHaveBeenCalledWith('XLM')
      expect(secondary.fetchPrice).toHaveBeenCalledWith('XLM')
    })

    it('returns null if all chained adapters return null', async () => {
      const first: PriceFeedAdapter = {
        name: 'FIRST',
        fetchPrice: jest.fn().mockResolvedValue(null),
      }
      const second: PriceFeedAdapter = {
        name: 'SECOND',
        fetchPrice: jest.fn().mockResolvedValue(null),
      }

      const composite = new CompositePriceFeedAdapter([first, second])
      const quote = await composite.fetchPrice('XLM')

      expect(quote).toBeNull()
    })
  })
})
