import {
  fetchOrderbookPrice,
  fetchStablecoinPrice,
  getCachedStablecoinPrice,
  setCachedStablecoinPrice,
  clearPriceFeedCache,
} from '../../../src/stellar/priceFeed'
import { fetchWithRetry } from '../../../src/utils/fetchWithRetry'

jest.mock('../../../src/utils/fetchWithRetry')
jest.mock('../../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}))

const mockFetchWithRetry = fetchWithRetry as jest.MockedFunction<
  typeof fetchWithRetry
>

describe('priceFeed', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    clearPriceFeedCache()
  })

  describe('fetchOrderbookPrice', () => {
    it('calculates mid-market price when both bids and asks are present', async () => {
      mockFetchWithRetry.mockResolvedValueOnce({
        bids: [{ price: '0.998', amount: '1000' }],
        asks: [{ price: '1.002', amount: '1000' }],
      })

      const price = await fetchOrderbookPrice()
      expect(price).toBeCloseTo(1.0, 4)
      expect(mockFetchWithRetry).toHaveBeenCalledTimes(1)
    })

    it('returns top bid when only bids are available', async () => {
      mockFetchWithRetry.mockResolvedValueOnce({
        bids: [{ price: '0.995', amount: '500' }],
        asks: [],
      })

      const price = await fetchOrderbookPrice()
      expect(price).toBe(0.995)
    })

    it('returns top ask when only asks are available', async () => {
      mockFetchWithRetry.mockResolvedValueOnce({
        bids: [],
        asks: [{ price: '1.005', amount: '500' }],
      })

      const price = await fetchOrderbookPrice()
      expect(price).toBe(1.005)
    })

    it('returns null when orderbook is empty', async () => {
      mockFetchWithRetry.mockResolvedValueOnce({
        bids: [],
        asks: [],
      })

      const price = await fetchOrderbookPrice()
      expect(price).toBeNull()
    })

    it('returns null when prices are non-positive or non-finite', async () => {
      mockFetchWithRetry.mockResolvedValueOnce({
        bids: [{ price: '0', amount: '100' }],
        asks: [{ price: '-1.5', amount: '100' }],
      })

      const price = await fetchOrderbookPrice()
      expect(price).toBeNull()
    })

    it('returns null when network request fails', async () => {
      mockFetchWithRetry.mockRejectedValueOnce(new Error('Network timeout'))

      const price = await fetchOrderbookPrice()
      expect(price).toBeNull()
    })

    it('constructs correct query url with custom options', async () => {
      mockFetchWithRetry.mockResolvedValueOnce({
        bids: [{ price: '0.999', amount: '100' }],
        asks: [{ price: '1.001', amount: '100' }],
      })

      await fetchOrderbookPrice({
        horizonUrl: 'https://custom-horizon.stellar.org',
        baseCode: 'USDC',
        baseIssuer: 'GISSUERBASE',
        counterCode: 'USDT',
        counterIssuer: 'GISSUERCOUNTER',
      })

      expect(mockFetchWithRetry).toHaveBeenCalledWith(
        expect.stringContaining(
          'https://custom-horizon.stellar.org/order_book?'
        ),
        expect.objectContaining({ timeout: 5000, retries: 3 })
      )
      const calledUrl = mockFetchWithRetry.mock.calls[0][0]
      expect(calledUrl).toContain('selling_asset_code=USDC')
      expect(calledUrl).toContain('selling_asset_issuer=GISSUERBASE')
      expect(calledUrl).toContain('buying_asset_code=USDT')
      expect(calledUrl).toContain('buying_asset_issuer=GISSUERCOUNTER')
    })
  })

  describe('fetchStablecoinPrice and cache', () => {
    it('fetches and caches stablecoin price', async () => {
      mockFetchWithRetry.mockResolvedValueOnce({
        bids: [{ price: '0.999', amount: '100' }],
        asks: [{ price: '1.001', amount: '100' }],
      })

      const price = await fetchStablecoinPrice('USDC')
      expect(price).toBeCloseTo(1.0, 4)

      const cached = getCachedStablecoinPrice('USDC')
      expect(cached).toBeCloseTo(1.0, 4)
    })

    it('does not cache when fetch fails', async () => {
      mockFetchWithRetry.mockRejectedValueOnce(new Error('Fetch error'))

      const price = await fetchStablecoinPrice('USDC')
      expect(price).toBeNull()

      const cached = getCachedStablecoinPrice('USDC')
      expect(cached).toBeNull()
    })

    it('respects cache expiration maxAgeMs', () => {
      setCachedStablecoinPrice('USDC', 1.0)
      expect(getCachedStablecoinPrice('USDC', 60000)).toBe(1.0)

      expect(getCachedStablecoinPrice('USDC', -1)).toBeNull()
    })

    it('supports manual cache updates and clearing', () => {
      setCachedStablecoinPrice('USDC', 0.985)
      expect(getCachedStablecoinPrice('USDC')).toBe(0.985)

      setCachedStablecoinPrice('USDC', null)
      expect(getCachedStablecoinPrice('USDC')).toBeNull()

      setCachedStablecoinPrice('USDC', 1.01)
      clearPriceFeedCache()
      expect(getCachedStablecoinPrice('USDC')).toBeNull()
    })
  })
})
