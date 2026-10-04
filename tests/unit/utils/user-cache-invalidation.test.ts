import {
  invalidatePortfolioCache,
  invalidateUserProfileCache,
  invalidateUserAssistantMemory,
  invalidateAllUserCaches,
  validateOrInvalidateCache,
  portfolioCacheKey,
  userProfileCacheKey,
  assistantMemoryCacheKey,
} from '../../../src/utils/user-cache-invalidation'
import { cacheGet, cacheSet, cacheDel } from '../../../src/config/redis'

jest.mock('../../../src/config/redis', () => ({
  cacheGet: jest.fn(),
  cacheSet: jest.fn(),
  cacheDel: jest.fn(),
}))

describe('User Cache Invalidation & Stale-Data Validation (#514)', () => {
  const mockCacheGet = cacheGet as jest.MockedFunction<typeof cacheGet>
  const mockCacheSet = cacheSet as jest.MockedFunction<typeof cacheSet>
  const mockCacheDel = cacheDel as jest.MockedFunction<typeof cacheDel>

  beforeEach(() => {
    jest.resetAllMocks()
  })

  describe('Cache Key Generators', () => {
    it('constructs correct portfolio cache key', () => {
      expect(portfolioCacheKey('user-123')).toBe('portfolio_snapshot:user-123')
    })

    it('constructs correct user profile cache key', () => {
      expect(userProfileCacheKey('user-123')).toBe('user_profile:user-123')
    })

    it('constructs correct assistant memory cache key', () => {
      expect(assistantMemoryCacheKey('whatsapp', 'user-123')).toBe(
        'assistant:memory:whatsapp:user-123'
      )
    })
  })

  describe('Invalidation Helpers', () => {
    it('invalidates portfolio cache correctly', async () => {
      mockCacheDel.mockResolvedValue(undefined)
      await invalidatePortfolioCache('user-123')
      expect(mockCacheDel).toHaveBeenCalledWith('portfolio_snapshot:user-123')
    })

    it('invalidates user profile cache correctly', async () => {
      mockCacheDel.mockResolvedValue(undefined)
      await invalidateUserProfileCache('user-123')
      expect(mockCacheDel).toHaveBeenCalledWith('user_profile:user-123')
    })

    it('invalidates assistant memory correctly', async () => {
      mockCacheDel.mockResolvedValue(undefined)
      await invalidateUserAssistantMemory('user-123', 'whatsapp')
      expect(mockCacheDel).toHaveBeenCalledWith(
        'assistant:memory:whatsapp:user-123'
      )
    })

    it('clears all user caches on invalidateAllUserCaches', async () => {
      mockCacheDel.mockResolvedValue(undefined)
      await invalidateAllUserCaches('user-123')

      expect(mockCacheDel).toHaveBeenCalledWith('portfolio_snapshot:user-123')
      expect(mockCacheDel).toHaveBeenCalledWith('user_profile:user-123')
      expect(mockCacheDel).toHaveBeenCalledWith(
        'assistant:memory:whatsapp:user-123'
      )
      expect(mockCacheDel).toHaveBeenCalledWith(
        'assistant:memory:telegram:user-123'
      )
      expect(mockCacheDel).toHaveBeenCalledWith('assistant:memory:api:user-123')
      expect(mockCacheDel).toHaveBeenCalledWith('assistant:memory:web:user-123')
    })
  })

  describe('validateOrInvalidateCache', () => {
    const key = 'test:key:1'
    const freshData = { id: 1, name: 'Alice' }

    it('fetches fresh data and stores in cache envelope when cache miss occurs', async () => {
      mockCacheGet.mockResolvedValue(null)
      mockCacheSet.mockResolvedValue(undefined)

      const fetchFresh = jest.fn().mockResolvedValue(freshData)

      const result = await validateOrInvalidateCache(key, fetchFresh, {}, 60)

      expect(result).toEqual(freshData)
      expect(fetchFresh).toHaveBeenCalledTimes(1)
      expect(mockCacheSet).toHaveBeenCalledWith(
        key,
        expect.objectContaining({
          data: freshData,
          cachedAt: expect.any(Number),
        }),
        60
      )
    })

    it('returns cached data when cache hit occurs and data is fresh', async () => {
      const envelope = {
        data: freshData,
        cachedAt: Date.now() - 1000, // 1 second ago
      }
      mockCacheGet.mockResolvedValue(envelope)

      const fetchFresh = jest.fn()

      const result = await validateOrInvalidateCache(
        key,
        fetchFresh,
        { maxAgeMs: 5000 },
        60
      )

      expect(result).toEqual(freshData)
      expect(fetchFresh).not.toHaveBeenCalled()
    })

    it.each([
      { data: freshData },
      { data: freshData, cachedAt: 'yesterday', version: 1 },
      { data: freshData, cachedAt: Date.now() + 60_000, version: 1 },
      { data: freshData, cachedAt: Date.now() },
      { data: freshData, cachedAt: Date.now(), version: 0 },
      { data: freshData, cachedAt: Date.now(), version: 2 },
      { data: freshData, cachedAt: NaN, version: 1 },
    ])('rejects malformed or incompatible envelope %j', async (envelope) => {
      mockCacheGet.mockResolvedValue(envelope)
      const fetchFresh = jest.fn().mockResolvedValue(freshData)
      expect(
        await validateOrInvalidateCache(key, fetchFresh, { version: 1 })
      ).toEqual(freshData)
      expect(fetchFresh).toHaveBeenCalledTimes(1)
      expect(mockCacheDel).toHaveBeenCalledWith(key)
    })

    it('uses the primary store if Redis reads fail', async () => {
      mockCacheGet.mockRejectedValue(new Error('offline'))
      mockCacheSet.mockRejectedValue(new Error('offline'))
      expect(
        await validateOrInvalidateCache(key, async () => freshData)
      ).toEqual(freshData)
    })

    it('does not return stale data when eviction fails', async () => {
      mockCacheGet.mockResolvedValue({ data: { old: true }, cachedAt: 1 })
      mockCacheDel.mockRejectedValue(new Error('offline'))
      expect(
        await validateOrInvalidateCache(key, async () => freshData)
      ).toEqual(freshData)
    })

    it('propagates primary-store errors without serving stale data', async () => {
      mockCacheGet.mockResolvedValue({ data: freshData, cachedAt: 1 })
      await expect(
        validateOrInvalidateCache(key, async () => {
          throw new Error('DB unavailable')
        })
      ).rejects.toThrow('DB unavailable')
    })

    it('does not cache a deleted primary-store record', async () => {
      mockCacheGet.mockResolvedValue({ data: freshData, cachedAt: 1 })
      expect(await validateOrInvalidateCache(key, async () => null)).toBeNull()
      expect(mockCacheSet).not.toHaveBeenCalled()
    })

    it('detects maxAgeMs staleness, evicts key, and re-fetches fresh data', async () => {
      const staleEnvelope = {
        data: { id: 1, name: 'Stale Alice' },
        cachedAt: Date.now() - 10000, // 10 seconds ago
      }
      mockCacheGet.mockResolvedValue(staleEnvelope)
      mockCacheDel.mockResolvedValue(undefined)
      mockCacheSet.mockResolvedValue(undefined)

      const fetchFresh = jest.fn().mockResolvedValue(freshData)

      const result = await validateOrInvalidateCache(
        key,
        fetchFresh,
        { maxAgeMs: 5000 },
        60
      )

      expect(mockCacheDel).toHaveBeenCalledWith(key)
      expect(fetchFresh).toHaveBeenCalledTimes(1)
      expect(result).toEqual(freshData)
    })

    it('detects updatedAt timestamp staleness, evicts key, and re-fetches fresh data', async () => {
      const cachedAt = Date.now() - 5000
      const updatedAt = new Date(Date.now() - 1000) // Updated 1 second ago (newer than cachedAt)
      const envelope = {
        data: { id: 1, name: 'Old Alice' },
        cachedAt,
      }
      mockCacheGet.mockResolvedValue(envelope)
      mockCacheDel.mockResolvedValue(undefined)

      const fetchFresh = jest.fn().mockResolvedValue(freshData)

      const result = await validateOrInvalidateCache(
        key,
        fetchFresh,
        { updatedAt },
        60
      )

      expect(mockCacheDel).toHaveBeenCalledWith(key)
      expect(fetchFresh).toHaveBeenCalledTimes(1)
      expect(result).toEqual(freshData)
    })
  })
})
