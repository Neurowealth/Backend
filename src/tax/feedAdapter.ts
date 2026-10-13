import { Decimal } from '@prisma/client/runtime/library'
import { logger } from '../utils/logger'
import { cacheGet, cacheSet } from '../config/redis'
import { fetchWithRetry } from '../utils/fetchWithRetry'

/**
 * Standardized quote data structure for asset market prices.
 */
export interface PriceQuote {
  price: Decimal
  source: string
  timestamp: Date
  metadata?: Record<string, unknown>
}

/**
 * Adapter interface for market price providers.
 */
export interface PriceFeedAdapter {
  name: string
  fetchPrice(assetSymbol: string): Promise<PriceQuote | null>
}

/**
 * Serialized representation of a quote stored in cache.
 */
interface SerializedQuote {
  price: string
  source: string
  timestamp: string
  metadata?: Record<string, unknown>
}

const DEFAULT_TTL_SECONDS = 300
const DEFAULT_HORIZON_URL = 'https://horizon.stellar.org'
const DEFAULT_STELLAR_EXPERT_URL = 'https://api.stellar.expert/explorer/public'
const DEFAULT_USDC_ISSUER =
  'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'

/**
 * Null price feed adapter used for offline/fallback mode.
 */
export class NullPriceFeedAdapter implements PriceFeedAdapter {
  readonly name = 'NULL_FEED'

  /**
   * Always returns null to represent unpriced assets or feed miss.
   * @param _assetSymbol Asset identifier
   * @returns null
   */
  async fetchPrice(_assetSymbol: string): Promise<PriceQuote | null> {
    return null
  }
}

/**
 * Horizon orderbook price feed adapter.
 */
export class HorizonOrderbookAdapter implements PriceFeedAdapter {
  readonly name = 'HORIZON_ORDERBOOK'
  private readonly horizonUrl: string
  private readonly usdcIssuer: string

  /**
   * Initializes the Horizon orderbook adapter.
   * @param horizonUrl Horizon API base URL
   * @param usdcIssuer Trusted USDC issuer account address
   */
  constructor(
    horizonUrl = process.env.HORIZON_URL || DEFAULT_HORIZON_URL,
    usdcIssuer = process.env.USDC_ISSUER || DEFAULT_USDC_ISSUER
  ) {
    this.horizonUrl = horizonUrl.replace(/\/$/, '')
    this.usdcIssuer = usdcIssuer
  }

  /**
   * Fetches the current mid-market price from the Horizon orderbook against USDC.
   * @param assetSymbol Asset identifier (e.g. 'XLM' or 'CODE:ISSUER')
   * @returns PriceQuote if orderbook has depth, or null on outage or empty book
   */
  async fetchPrice(assetSymbol: string): Promise<PriceQuote | null> {
    try {
      const url = this.buildOrderbookUrl(assetSymbol)
      if (!url) {
        return null
      }

      const data = await fetchWithRetry(url, {
        timeout: 4000,
        retries: 2,
        retryDelay: 300,
      })

      const bids = Array.isArray(data?.bids) ? data.bids : []
      const asks = Array.isArray(data?.asks) ? data.asks : []

      if (bids.length === 0 && asks.length === 0) {
        return null
      }

      const bestBid = bids[0]?.price ? new Decimal(bids[0].price) : null
      const bestAsk = asks[0]?.price ? new Decimal(asks[0].price) : null

      let derivedPrice: Decimal | null = null
      if (bestBid && bestAsk) {
        derivedPrice = bestBid.plus(bestAsk).dividedBy(2)
      } else if (bestBid) {
        derivedPrice = bestBid
      } else if (bestAsk) {
        derivedPrice = bestAsk
      }

      if (
        !derivedPrice ||
        !derivedPrice.isPositive() ||
        derivedPrice.isZero()
      ) {
        return null
      }

      return {
        price: derivedPrice,
        source: this.name,
        timestamp: new Date(),
        metadata: {
          bestBid: bids[0]?.price ?? null,
          bestAsk: asks[0]?.price ?? null,
          sellingAsset: assetSymbol,
          buyingAsset: 'USDC',
        },
      }
    } catch (error) {
      logger.warn('[HorizonOrderbookAdapter] Failed to fetch price', {
        assetSymbol,
        error: error instanceof Error ? error.message : String(error),
      })
      return null
    }
  }

  /**
   * Constructs the query URL for the Horizon orderbook endpoint.
   * @param assetSymbol Asset identifier
   * @returns Formatted Horizon URL or null if asset format is invalid
   */
  private buildOrderbookUrl(assetSymbol: string): string | null {
    const symbol = assetSymbol.trim().toUpperCase()
    const buyingParams = `buying_asset_type=credit_alphanum4&buying_asset_code=USDC&buying_asset_issuer=${this.usdcIssuer}`

    if (symbol === 'XLM' || symbol === 'NATIVE') {
      return `${this.horizonUrl}/order_book?selling_asset_type=native&${buyingParams}&limit=5`
    }

    if (symbol.includes(':')) {
      const [code, issuer] = symbol.split(':')
      if (!code || !issuer) {
        return null
      }
      const assetType =
        code.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12'
      return `${this.horizonUrl}/order_book?selling_asset_type=${assetType}&selling_asset_code=${encodeURIComponent(code)}&selling_asset_issuer=${encodeURIComponent(issuer)}&${buyingParams}&limit=5`
    }

    return null
  }
}

/**
 * Stellar Expert public API price feed adapter.
 */
export class StellarExpertAdapter implements PriceFeedAdapter {
  readonly name = 'STELLAR_EXPERT'
  private readonly baseUrl: string

  /**
   * Initializes the Stellar Expert adapter.
   * @param baseUrl Base URL of the Stellar Expert explorer API
   */
  constructor(
    baseUrl = process.env.STELLAR_EXPERT_API_URL || DEFAULT_STELLAR_EXPERT_URL
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
  }

  /**
   * Fetches the USD price of an asset from Stellar Expert.
   * @param assetSymbol Asset identifier
   * @returns PriceQuote or null on error or missing price
   */
  async fetchPrice(assetSymbol: string): Promise<PriceQuote | null> {
    try {
      const formattedAsset = this.formatAssetId(assetSymbol)
      const url = `${this.baseUrl}/asset/${formattedAsset}`

      const data = await fetchWithRetry(url, {
        timeout: 4000,
        retries: 2,
        retryDelay: 300,
      })

      if (data?.price === undefined || data?.price === null) {
        return null
      }

      const decimalPrice = new Decimal(data.price)
      if (!decimalPrice.isPositive() || decimalPrice.isZero()) {
        return null
      }

      return {
        price: decimalPrice,
        source: this.name,
        timestamp: new Date(),
        metadata: {
          asset: data.asset,
          supply: data.supply,
        },
      }
    } catch (error) {
      logger.warn('[StellarExpertAdapter] Failed to fetch price', {
        assetSymbol,
        error: error instanceof Error ? error.message : String(error),
      })
      return null
    }
  }

  /**
   * Formats an asset identifier for the Stellar Expert API path.
   * @param assetSymbol Asset symbol or CODE:ISSUER
   * @returns Path component for Stellar Expert
   */
  private formatAssetId(assetSymbol: string): string {
    const symbol = assetSymbol.trim().toUpperCase()
    if (symbol.includes(':')) {
      return symbol.replace(':', '-')
    }
    return symbol
  }
}

/**
 * Configurable HTTP oracle adapter.
 */
export class HttpOracleAdapter implements PriceFeedAdapter {
  readonly name = 'HTTP_ORACLE'
  private readonly oracleUrl?: string

  /**
   * Initializes the HTTP oracle adapter.
   * @param oracleUrl Custom HTTP oracle URL or template
   */
  constructor(
    oracleUrl = process.env.TAX_PRICE_FEED_URL || process.env.PRICE_ORACLE_URL
  ) {
    this.oracleUrl = oracleUrl
  }

  /**
   * Fetches asset price from a configured external HTTP oracle.
   * @param assetSymbol Asset identifier
   * @returns PriceQuote or null if unconfigured, unreachable, or missing
   */
  async fetchPrice(assetSymbol: string): Promise<PriceQuote | null> {
    if (!this.oracleUrl) {
      return null
    }

    try {
      const url = this.oracleUrl.includes('{asset}')
        ? this.oracleUrl.replace('{asset}', encodeURIComponent(assetSymbol))
        : `${this.oracleUrl}${this.oracleUrl.includes('?') ? '&' : '?'}asset=${encodeURIComponent(assetSymbol)}`

      const data = await fetchWithRetry(url, {
        timeout: 4000,
        retries: 2,
        retryDelay: 300,
      })

      const rawPrice = this.extractPrice(data, assetSymbol)
      if (rawPrice === null) {
        return null
      }

      const decimalPrice = new Decimal(rawPrice)
      if (!decimalPrice.isPositive() || decimalPrice.isZero()) {
        return null
      }

      return {
        price: decimalPrice,
        source: this.name,
        timestamp: new Date(),
        metadata: {
          endpoint: this.oracleUrl,
        },
      }
    } catch (error) {
      logger.warn('[HttpOracleAdapter] Failed to fetch price', {
        assetSymbol,
        error: error instanceof Error ? error.message : String(error),
      })
      return null
    }
  }

  /**
   * Extracts a numeric or string price value from various JSON oracle response shapes.
   * @param data Parsed JSON response body
   * @param assetSymbol Requested asset symbol
   * @returns Price value string or number, or null
   */
  private extractPrice(data: any, assetSymbol: string): string | number | null {
    if (data?.price !== undefined && data?.price !== null) {
      return data.price
    }
    if (data?.usd !== undefined && data?.usd !== null) {
      return data.usd
    }

    const key = assetSymbol.toUpperCase()
    if (data?.[key]?.price !== undefined) {
      return data[key].price
    }
    if (data?.[key]?.usd !== undefined) {
      return data[key].usd
    }
    if (
      data?.[key] !== undefined &&
      (typeof data[key] === 'string' || typeof data[key] === 'number')
    ) {
      return data[key]
    }

    const lowerKey = assetSymbol.toLowerCase()
    if (data?.[lowerKey]?.usd !== undefined) {
      return data[lowerKey].usd
    }

    return null
  }
}

/**
 * Composite adapter chaining multiple pricing sources with honest null fallback.
 */
export class CompositePriceFeedAdapter implements PriceFeedAdapter {
  readonly name = 'COMPOSITE_FEED'
  private readonly adapters: PriceFeedAdapter[]

  /**
   * Initializes the composite adapter.
   * @param adapters Ordered list of price feed adapters to query
   */
  constructor(adapters?: PriceFeedAdapter[]) {
    if (adapters && adapters.length > 0) {
      this.adapters = adapters
    } else {
      this.adapters = [
        new HttpOracleAdapter(),
        new HorizonOrderbookAdapter(),
        new StellarExpertAdapter(),
      ]
    }
  }

  /**
   * Sequentially queries configured adapters until a valid quote is found.
   * @param assetSymbol Asset identifier
   * @returns PriceQuote or null if all adapters fail
   */
  async fetchPrice(assetSymbol: string): Promise<PriceQuote | null> {
    for (const adapter of this.adapters) {
      const quote = await adapter.fetchPrice(assetSymbol)
      if (quote) {
        return quote
      }
    }
    return null
  }
}

interface CacheItem {
  quote: PriceQuote
  expiresAt: number
}

const memoryCache = new Map<string, CacheItem>()
const metadataStore = new Map<string, PriceQuote>()

function createDefaultAdapter(): PriceFeedAdapter {
  if (
    process.env.NODE_ENV === 'test' &&
    !process.env.TAX_PRICE_FEED_URL &&
    process.env.TAX_PRICE_FEED_LIVE !== 'true'
  ) {
    return new NullPriceFeedAdapter()
  }
  return new CompositePriceFeedAdapter()
}

let activeAdapter: PriceFeedAdapter = createDefaultAdapter()

/**
 * Resolves configured cache TTL in seconds.
 * @returns TTL in seconds
 */
export function getFeedCacheTtlSeconds(): number {
  const envVal = process.env.TAX_PRICE_FEED_TTL_SECONDS
  if (envVal) {
    const parsed = parseInt(envVal, 10)
    if (!isNaN(parsed) && parsed > 0) {
      return parsed
    }
  }
  return DEFAULT_TTL_SECONDS
}

/**
 * Updates the active price feed adapter.
 * @param adapter New price feed adapter instance
 */
export function setPriceFeedAdapter(adapter: PriceFeedAdapter): void {
  activeAdapter = adapter
}

/**
 * Restores the default price feed adapter.
 */
export function resetPriceFeedAdapter(): void {
  activeAdapter = createDefaultAdapter()
}

/**
 * Clears in-memory caches and quote metadata.
 */
export async function clearPriceFeedCache(): Promise<void> {
  memoryCache.clear()
  metadataStore.clear()
}

/**
 * Retrieves the latest cached or stored quote metadata for an asset.
 * @param assetSymbol Asset identifier
 * @returns Latest PriceQuote metadata or null
 */
export async function getQuoteMetadata(
  assetSymbol: string
): Promise<PriceQuote | null> {
  const normalized = assetSymbol.trim().toUpperCase()
  const inMemory = metadataStore.get(normalized)
  if (inMemory) {
    return inMemory
  }

  const redisKey = `tax:quote:meta:${normalized}`
  const cached = await cacheGet<SerializedQuote>(redisKey)
  if (cached) {
    const quote: PriceQuote = {
      price: new Decimal(cached.price),
      source: cached.source,
      timestamp: new Date(cached.timestamp),
      metadata: cached.metadata,
    }
    metadataStore.set(normalized, quote)
    return quote
  }

  return null
}

/**
 * Checks in-memory cache synchronously for a valid unexpired price.
 * @param assetSymbol Asset identifier
 * @returns Cached Decimal price or null
 */
export function getCachedPriceSync(assetSymbol: string): Decimal | null {
  const normalized = assetSymbol.trim().toUpperCase()
  const cached = memoryCache.get(normalized)
  if (cached && Date.now() < cached.expiresAt) {
    return cached.quote.price
  }
  return null
}

/**
 * Retrieves an asset price, checking in-memory cache, Redis cache, and upstream adapter.
 * @param assetSymbol Asset identifier
 * @returns Verified Decimal price or null on miss/outage
 */
export async function fetchPriceFromFeed(
  assetSymbol: string
): Promise<Decimal | null> {
  const normalized = assetSymbol.trim().toUpperCase()

  const syncPrice = getCachedPriceSync(normalized)
  if (syncPrice !== null) {
    return syncPrice
  }

  const ttlSeconds = getFeedCacheTtlSeconds()
  const redisKey = `tax:quote:${normalized}`
  const cached = await cacheGet<SerializedQuote>(redisKey)
  if (cached) {
    const quote: PriceQuote = {
      price: new Decimal(cached.price),
      source: cached.source,
      timestamp: new Date(cached.timestamp),
      metadata: cached.metadata,
    }
    memoryCache.set(normalized, {
      quote,
      expiresAt: Date.now() + ttlSeconds * 1000,
    })
    metadataStore.set(normalized, quote)
    return quote.price
  }

  let quote: PriceQuote | null = null
  try {
    quote = await activeAdapter.fetchPrice(normalized)
  } catch (error) {
    logger.warn('[fetchPriceFromFeed] Active adapter failed', {
      assetSymbol: normalized,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }

  if (!quote) {
    return null
  }

  memoryCache.set(normalized, {
    quote,
    expiresAt: Date.now() + ttlSeconds * 1000,
  })
  metadataStore.set(normalized, quote)

  const serialized: SerializedQuote = {
    price: quote.price.toString(),
    source: quote.source,
    timestamp: quote.timestamp.toISOString(),
    metadata: quote.metadata,
  }

  await cacheSet(redisKey, serialized, ttlSeconds)
  await cacheSet(`tax:quote:meta:${normalized}`, serialized, ttlSeconds)

  return quote.price
}
