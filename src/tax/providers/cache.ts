import { PriceFeedResult } from './types'

interface CacheEntry {
  result: PriceFeedResult
  expiresAt: number
}

const DEFAULT_HISTORICAL_TTL_MS = 3_600_000
const DEFAULT_SPOT_TTL_MS = 60_000
const MAX_CACHE_ENTRIES = 1_000

/**
 * In-memory bounded-TTL cache for tax pricing queries.
 * Prevents redundant external calls during batch tax reporting while enforcing memory bounds.
 */
export class PriceFeedCache {
  private readonly store = new Map<string, CacheEntry>()
  private readonly maxEntries: number

  constructor(maxEntries: number = MAX_CACHE_ENTRIES) {
    this.maxEntries = maxEntries
  }

  /**
   * Format cache key based on asset symbol and date granularity.
   */
  private buildKey(assetSymbol: string, asOfDate?: Date): string {
    const datePart = asOfDate ? asOfDate.toISOString().slice(0, 10) : 'spot'
    return `${assetSymbol.toUpperCase()}:${datePart}`
  }

  /**
   * Retrieve cached price result if present and unexpired.
   */
  get(assetSymbol: string, asOfDate?: Date): PriceFeedResult | null {
    const key = this.buildKey(assetSymbol, asOfDate)
    const entry = this.store.get(key)
    if (!entry) {
      return null
    }

    if (Date.now() > entry.expiresAt) {
      this.store.delete(key)
      return null
    }

    return entry.result
  }

  /**
   * Store price result with bounded TTL and capacity eviction.
   */
  set(
    assetSymbol: string,
    result: PriceFeedResult,
    asOfDate?: Date,
    ttlMs?: number
  ): void {
    const key = this.buildKey(assetSymbol, asOfDate)
    const effectiveTtl =
      ttlMs ?? (asOfDate ? DEFAULT_HISTORICAL_TTL_MS : DEFAULT_SPOT_TTL_MS)

    if (this.store.size >= this.maxEntries) {
      const oldestKey = this.store.keys().next().value
      if (oldestKey) {
        this.store.delete(oldestKey)
      }
    }

    this.store.set(key, {
      result,
      expiresAt: Date.now() + effectiveTtl,
    })
  }

  /**
   * Purge all cached pricing entries.
   */
  clear(): void {
    this.store.clear()
  }

  /**
   * Return active cache size.
   */
  size(): number {
    return this.store.size
  }
}

export const defaultPriceCache = new PriceFeedCache()
