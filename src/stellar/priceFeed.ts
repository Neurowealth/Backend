import { fetchWithRetry } from '../utils/fetchWithRetry'
import { logger } from '../utils/logger'

export interface OrderbookPriceOptions {
  horizonUrl?: string
  baseCode?: string
  baseIssuer?: string
  baseType?: 'native' | 'credit_alphanum4' | 'credit_alphanum12'
  counterCode?: string
  counterIssuer?: string
  counterType?: 'native' | 'credit_alphanum4' | 'credit_alphanum12'
  timeoutMs?: number
  retries?: number
}

export interface HorizonOrderbookEntry {
  price: string
  amount: string
  price_r?: {
    n: number
    d: number
  }
}

export interface HorizonOrderbookResponse {
  bids?: HorizonOrderbookEntry[]
  asks?: HorizonOrderbookEntry[]
  base?: Record<string, unknown>
  counter?: Record<string, unknown>
}

interface PriceFeedCacheEntry {
  price: number
  timestamp: number
}

const priceCache = new Map<string, PriceFeedCacheEntry>()

/**
 * Fetch spot price from the Stellar Horizon DEX orderbook.
 * Returns the mid-market price between top bid and top ask.
 * Returns null if the orderbook is empty, unconfigured, or unreachable.
 */
export async function fetchOrderbookPrice(
  options: OrderbookPriceOptions = {}
): Promise<number | null> {
  const horizonUrl = (
    options.horizonUrl ||
    process.env.HORIZON_URL ||
    'https://horizon.stellar.org'
  ).replace(/\/+$/, '')

  const baseCode = options.baseCode || 'USDC'
  const baseIssuer =
    options.baseIssuer ||
    process.env.USDC_ISSUER ||
    'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
  const baseType = options.baseType || 'credit_alphanum4'

  const counterCode =
    options.counterCode ||
    process.env.BREAKER_DEPEG_COUNTER_CODE ||
    process.env.STABLECOIN_COUNTER_CODE ||
    'USDT'
  const counterIssuer =
    options.counterIssuer ||
    process.env.BREAKER_DEPEG_COUNTER_ISSUER ||
    process.env.STABLECOIN_COUNTER_ISSUER ||
    'GCQTGZQQ5G4PTM2GL7CDIFKUBIPEC52BROAQJW42LLDBAKYWTTRPPMTW'
  const counterType =
    options.counterType ||
    (counterIssuer
      ? counterCode.length > 4
        ? 'credit_alphanum12'
        : 'credit_alphanum4'
      : 'native')

  if (baseType !== 'native' && !baseIssuer) {
    return null
  }
  if (counterType !== 'native' && !counterIssuer) {
    return null
  }

  const timeout = options.timeoutMs ?? 5000
  const retries = options.retries ?? 3

  try {
    const params = new URLSearchParams()
    params.set('selling_asset_type', baseType)
    if (baseType !== 'native') {
      params.set('selling_asset_code', baseCode)
      if (baseIssuer) {
        params.set('selling_asset_issuer', baseIssuer)
      }
    }

    params.set('buying_asset_type', counterType)
    if (counterType !== 'native') {
      params.set('buying_asset_code', counterCode)
      if (counterIssuer) {
        params.set('buying_asset_issuer', counterIssuer)
      }
    }
    params.set('limit', '1')

    const url = `${horizonUrl}/order_book?${params.toString()}`
    const data: HorizonOrderbookResponse = await fetchWithRetry(url, {
      timeout,
      retries,
      retryDelay: 500,
    })

    const topBidStr =
      data.bids && data.bids.length > 0 ? data.bids[0].price : null
    const topAskStr =
      data.asks && data.asks.length > 0 ? data.asks[0].price : null

    const topBid = topBidStr !== null ? parseFloat(topBidStr) : null
    const topAsk = topAskStr !== null ? parseFloat(topAskStr) : null

    const validBid =
      topBid !== null && Number.isFinite(topBid) && topBid > 0 ? topBid : null
    const validAsk =
      topAsk !== null && Number.isFinite(topAsk) && topAsk > 0 ? topAsk : null

    if (validBid !== null && validAsk !== null) {
      return (validBid + validAsk) / 2
    }
    if (validBid !== null) {
      return validBid
    }
    if (validAsk !== null) {
      return validAsk
    }

    return null
  } catch (error) {
    logger.warn('[PriceFeed] Failed to fetch orderbook price from Horizon', {
      baseCode,
      counterCode,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/**
 * Retrieve the current cached spot price for a stablecoin synchronously.
 * Returns null if no price is cached or if the cached price is older than maxAgeMs.
 */
export function getCachedStablecoinPrice(
  symbol = 'USDC',
  maxAgeMs = 300000
): number | null {
  const entry = priceCache.get(symbol.toUpperCase())
  if (!entry) {
    return null
  }
  if (Date.now() - entry.timestamp > maxAgeMs) {
    return null
  }
  return entry.price
}

/**
 * Fetch the latest spot price for a stablecoin, using the cached price if fresh.
 * If cache is expired or absent, queries the Horizon DEX orderbook and updates cache.
 * Returns null if the feed is unreachable, unconfigured, or invalid.
 */
export async function getStablecoinPrice(
  symbol = 'USDC',
  options: OrderbookPriceOptions = {},
  maxAgeMs = 300000
): Promise<number | null> {
  const cached = getCachedStablecoinPrice(symbol, maxAgeMs)
  if (cached !== null) {
    return cached
  }

  const price = await fetchOrderbookPrice({
    baseCode: symbol,
    ...options,
  })

  if (price !== null && Number.isFinite(price) && price > 0) {
    priceCache.set(symbol.toUpperCase(), {
      price,
      timestamp: Date.now(),
    })
    return price
  }

  return null
}

/**
 * Force fetch the latest spot price for a stablecoin and update the cache.
 */
export async function fetchStablecoinPrice(
  symbol = 'USDC',
  options: OrderbookPriceOptions = {}
): Promise<number | null> {
  return getStablecoinPrice(symbol, options, -1)
}

/**
 * Set a cached price for an asset. Used for preloading or testing.
 */
export function setCachedStablecoinPrice(
  symbol: string,
  price: number | null
): void {
  const key = symbol.toUpperCase()
  if (price === null) {
    priceCache.delete(key)
    return
  }
  priceCache.set(key, {
    price,
    timestamp: Date.now(),
  })
}

/**
 * Clear all entries from the in-memory price feed cache.
 */
export function clearPriceFeedCache(): void {
  priceCache.clear()
}
