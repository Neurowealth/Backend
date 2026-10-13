import { StellarDexPriceFeedProvider } from '../../../../src/tax/providers/stellarDexProvider'
import { fetchWithRetry } from '../../../../src/utils/fetchWithRetry'

jest.mock('../../../../src/utils/fetchWithRetry', () => ({
  fetchWithRetry: jest.fn(),
}))

jest.mock('../../../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}))

const mockFetch = fetchWithRetry as jest.Mock

describe('StellarDexPriceFeedProvider', () => {
  let provider: StellarDexPriceFeedProvider

  beforeEach(() => {
    jest.clearAllMocks()
    provider = new StellarDexPriceFeedProvider(
      'https://horizon.stellar.org',
      'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
    )
  })

  it('prices USDC as 1.00 USD without network calls', async () => {
    const result = await provider.getPrice(
      'USDC',
      new Date('2026-01-01T00:00:00Z')
    )

    expect(result).not.toBeNull()
    expect(result?.price.toString()).toBe('1')
    expect(result?.confidence).toBe('HIGH')
    expect(result?.caveat).toBeNull()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('resolves historical price from daily close trade aggregation with high confidence', async () => {
    const targetDate = new Date('2026-03-10T14:30:00Z')
    mockFetch.mockResolvedValueOnce({
      _embedded: {
        records: [
          {
            timestamp: 1773187200000,
            close: '0.1285000',
            avg: '0.1280000',
            count: 42,
            base_volume: '150000.0000000',
            counter_volume: '19275.0000000',
          },
        ],
      },
    })

    const result = await provider.getPrice('XLM', targetDate)

    expect(result).not.toBeNull()
    expect(result?.price.toString()).toBe('0.1285')
    expect(result?.confidence).toBe('HIGH')
    expect(result?.granularity).toBe('DAILY_CLOSE')
    expect(result?.caveat).toBeNull()
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(mockFetch.mock.calls[0][0]).toContain('/trade_aggregations')
    expect(mockFetch.mock.calls[0][0]).toContain('base_asset_type=native')
  })

  it('flags low confidence for thin liquidity historical trades', async () => {
    const targetDate = new Date('2026-03-10T14:30:00Z')
    mockFetch.mockResolvedValueOnce({
      _embedded: {
        records: [
          {
            timestamp: 1773187200000,
            close: '0.0500000',
            avg: '0.0500000',
            count: 2,
            base_volume: '100.0000000',
            counter_volume: '5.0000000',
          },
        ],
      },
    })

    const result = await provider.getPrice('XLM', targetDate)

    expect(result).not.toBeNull()
    expect(result?.price.toString()).toBe('0.05')
    expect(result?.confidence).toBe('LOW')
    expect(result?.caveat).toContain('Thin trading volume')
  })

  it('falls back to nearest trade aggregation when exact day has no trades', async () => {
    const targetDate = new Date('2026-03-10T14:30:00Z')
    mockFetch.mockResolvedValueOnce({
      _embedded: { records: [] },
    })

    const nearestTimestamp = new Date('2026-03-08T00:00:00Z').getTime()
    mockFetch.mockResolvedValueOnce({
      _embedded: {
        records: [
          {
            timestamp: nearestTimestamp,
            close: '0.1210000',
            count: 25,
            counter_volume: '5000.0000000',
          },
        ],
      },
    })

    const result = await provider.getPrice('XLM', targetDate)

    expect(result).not.toBeNull()
    expect(result?.price.toString()).toBe('0.121')
    expect(result?.confidence).toBe('LOW')
    expect(result?.granularity).toBe('FALLBACK_NEAREST')
    expect(result?.caveat).toContain('nearest available trade aggregation')
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('falls back to spot route quote for recent dates when historical records are empty', async () => {
    const recentDate = new Date(Date.now() - 3600 * 1000)
    mockFetch.mockResolvedValueOnce({
      _embedded: { records: [] },
    })
    mockFetch.mockResolvedValueOnce({
      _embedded: { records: [] },
    })
    mockFetch.mockResolvedValueOnce({
      _embedded: {
        records: [
          {
            source_amount: '1.0000000',
            dest_amount: '0.1320000',
            path: [],
            source_asset_type: 'native',
            destination_asset_type: 'credit_alphanum4',
            destination_asset_code: 'USDC',
            destination_asset_issuer:
              'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
          },
        ],
      },
    })

    const result = await provider.getPrice('XLM', recentDate)

    expect(result).not.toBeNull()
    expect(result?.price.toString()).toBe('0.132')
    expect(result?.confidence).toBe('LOW')
    expect(result?.caveat).toContain('fell back to spot quote')
  })

  it('returns null when old historical date has no records and cannot fall back to spot', async () => {
    const oldDate = new Date('2023-01-01T00:00:00Z')
    mockFetch.mockResolvedValueOnce({
      _embedded: { records: [] },
    })
    mockFetch.mockResolvedValueOnce({
      _embedded: { records: [] },
    })

    const result = await provider.getPrice('XLM', oldDate)

    expect(result).toBeNull()
  })

  it('handles network outages gracefully by logging warning and returning null', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Horizon gateway timeout'))

    const result = await provider.getPrice(
      'XLM',
      new Date('2026-03-01T00:00:00Z')
    )

    expect(result).toBeNull()
  })

  it('queries spot strict-send path when asOfDate is not provided', async () => {
    mockFetch.mockResolvedValueOnce({
      _embedded: {
        records: [
          {
            source_amount: '1.0000000',
            dest_amount: '0.1450000',
            path: [],
            source_asset_type: 'native',
            destination_asset_type: 'credit_alphanum4',
            destination_asset_code: 'USDC',
            destination_asset_issuer:
              'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
          },
        ],
      },
    })

    const result = await provider.getPrice('XLM')

    expect(result).not.toBeNull()
    expect(result?.price.toString()).toBe('0.145')
    expect(result?.granularity).toBe('SPOT')
    expect(result?.confidence).toBe('HIGH')
  })

  it('correctly constructs query parameters for issued non-native assets', async () => {
    const asset = 'BTC:GBHUXM6YTH36556VTN7J6IK37MYSUO2AITPRSJMG4O2FCUMDLW42UFHI'
    const targetDate = new Date('2026-03-10T00:00:00Z')
    mockFetch.mockResolvedValueOnce({
      _embedded: {
        records: [
          {
            timestamp: 1773187200000,
            close: '65000.00',
            count: 10,
            counter_volume: '650000.00',
          },
        ],
      },
    })

    const result = await provider.getPrice(asset, targetDate)

    expect(result).not.toBeNull()
    expect(result?.price.toString()).toBe('65000')
    const queryUrl = mockFetch.mock.calls[0][0]
    expect(queryUrl).toContain('base_asset_code=BTC')
    expect(queryUrl).toContain(
      'base_asset_issuer=GBHUXM6YTH36556VTN7J6IK37MYSUO2AITPRSJMG4O2FCUMDLW42UFHI'
    )
  })
})
