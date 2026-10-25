/**
 * src/stellar/routing.ts
 *
 * Path-payment routing primitives for DEX auto-routing.
 * Provides strict-send and strict-receive path finding with slippage protection.
 */

import { Asset, Operation } from '@stellar/stellar-sdk'
import { logger } from '../utils/logger'
import { fetchWithRetry } from '../utils/fetchWithRetry'

// ── Configuration ───────────────────────────────────────────────────────────────

const ROUTING_QUOTE_TTL_MS = 30_000 // 30 seconds
const ROUTING_SLIPPAGE_MIN_BPS = 10 // 0.1%
const ROUTING_SLIPPAGE_MAX_BPS = 300 // 3%
const ROUTING_SLIPPAGE_DEFAULT_BPS = 50 // 0.5%
const ROUTING_PRICE_IMPACT_WARN_BPS = 100 // 1%
const ROUTING_HORIZON_TIMEOUT_MS = 5_000
const ROUTING_HORIZON_RETRIES = 3

// ── Types ───────────────────────────────────────────────────────────────────────

export interface RoutedQuote {
  sourceAsset: string
  sourceAmount: string
  destAsset: string
  destAmountMin: string
  estDestAmount: string
  path: string[]
  priceImpactBps: number
  expiresAt: Date
  highImpact: boolean
}

export interface PathPaymentParams {
  sourceAsset: string
  sourceAmount: string
  destAsset: string
  destAmount?: string
  slippageBps?: number
}

// ── Asset Parsing ───────────────────────────────────────────────────────────────

function parseAsset(assetStr: string): Asset {
  if (assetStr === 'XLM') {
    return Asset.native()
  }
  const [code, issuer] = assetStr.split(':')
  if (!code || !issuer) {
    throw new Error(`Invalid asset format: ${assetStr}`)
  }
  return new Asset(code, issuer)
}

function assetToString(asset: Asset): string {
  if (asset.isNative()) {
    return 'XLM'
  }
  return `${asset.code}:${asset.issuer}`
}

// ── Horizon path finding ─────────────────────────────────────────────────────────

/**
 * Minimal shape of the Horizon path-finding record. Only the fields routing
 * needs are typed; the endpoint returns more.
 */
interface HorizonPathRecord {
  source_amount?: string
  dest_amount?: string
  path?: Array<{ asset_code?: string; asset_issuer?: string }>
  source_asset_type?: string
  source_asset_code?: string
  source_asset_issuer?: string
}

const DEFAULT_HORIZON_URL = 'https://horizon.stellar.org'

function horizonBaseUrl(): string {
  const configured = process.env.HORIZON_URL || DEFAULT_HORIZON_URL
  return configured.replace(/\/+$/, '')
}

function horizonPathFindingUrl(
  mode: 'strict-send' | 'strict-receive',
  params: Record<string, string>
): string {
  const query = new URLSearchParams(params).toString()
  return `${horizonBaseUrl()}/path/${mode}?${query}`
}

async function fetchPathRecords(url: string): Promise<HorizonPathRecord[]> {
  const payload = await fetchWithRetry(url, {
    timeout: ROUTING_HORIZON_TIMEOUT_MS,
    retries: ROUTING_HORIZON_RETRIES,
  })

  const records = payload?._embedded?.records
  if (!Array.isArray(records)) {
    throw new Error('Horizon path finding returned an unexpected payload shape')
  }
  return records as HorizonPathRecord[]
}

/**
 * Horizon returns every acceptable path ordered by rate. We quote the first
 * (best) one, but a multi-record response is itself a signal that liquidity is
 * thin, so `computePriceImpactBps` accounts for the extra hops.
 */
function requireSingleRecord(
  records: HorizonPathRecord[],
  mode: string
): HorizonPathRecord {
  const record = records[0]
  if (!record) {
    throw new Error(`Horizon ${mode} returned no path`)
  }
  return record
}

/**
 * Horizon's `path` array holds the intermediate assets. The returned
 * `RoutedQuote.path` follows the same convention as `buildPathPaymentOp`,
 * which slices off the first and last entries as the source and destination.
 */
function extractPath(
  records: HorizonPathRecord[],
  sourceAsset: string,
  destAsset: string
): string[] {
  const record = records[0]
  const intermediates = record?.path ?? []

  const hops: string[] = intermediates
    .map((hop) => {
      if (!hop.asset_code) return null
      return hop.asset_issuer
        ? `${hop.asset_code}:${hop.asset_issuer}`
        : hop.asset_code
    })
    .filter((hop): hop is string => hop !== null)

  // A path of [source, ...intermediates, dest] means zero or more conversions.
  // When there are no hops the caller gets [source, dest] so the existing
  // `slice(1, -1)` in buildPathPaymentOp still yields an empty path array.
  if (hops.length === 0) return [sourceAsset, destAsset]
  return [sourceAsset, ...hops, destAsset]
}

/**
 * Price impact relative to a 1:1 nominal, expressed in basis points. A
 * multi-path response means the best single rate was marginal, so each extra
 * available record adds a small penalty to reflect the thin liquidity.
 */
function computePriceImpactBps(
  sourceAmount: number,
  destAmount: number,
  recordCount: number
): number {
  if (sourceAmount <= 0 || destAmount <= 0) return 0

  const impact = Math.abs(1 - destAmount / sourceAmount) * 10_000
  const extraHops = Math.max(0, recordCount - 1)
  return Math.round(impact + extraHops)
}

/** Apply slippage tolerance, never returning a negative minimum. */
function applySlippage(destAmount: string, slippageBps: number): string {
  const amount = Number(destAmount)
  if (!Number.isFinite(amount)) {
    throw new Error(
      `Cannot apply slippage to non-numeric amount: ${destAmount}`
    )
  }
  const min = amount * (1 - slippageBps / 10_000)
  return Math.max(0, min).toFixed(7)
}

// ── Path Finding ───────────────────────────────────────────────────────────────

export async function findStrictSendPath(
  params: Omit<PathPaymentParams, 'slippageBps'> & { slippageBps?: number }
): Promise<RoutedQuote> {
  const { sourceAsset, sourceAmount, destAsset } = params
  const slippageBps = clampSlippage(params.slippageBps)

  // Validate both assets up front so a malformed asset string fails before any
  // network call is made.
  parseAsset(sourceAsset)
  parseAsset(destAsset)

  const url = horizonPathFindingUrl('strict-send', {
    source_asset: sourceAsset,
    dest_asset: destAsset,
    source_amount: sourceAmount,
  })

  try {
    const records = await fetchPathRecords(url)
    const record = requireSingleRecord(records, 'strict-send')

    const destAmount = record.dest_amount
    if (destAmount === undefined) {
      throw new Error('Horizon strict-send response is missing dest_amount')
    }

    // Horizon returns a 1:1 nominal for a direct path; the real rate is the
    // ratio between what we send and what we receive.
    const sourceAmountNum = Number(sourceAmount)
    const destAmountNum = Number(destAmount)
    if (!Number.isFinite(sourceAmountNum) || !Number.isFinite(destAmountNum)) {
      throw new Error(
        `Horizon strict-send returned non-numeric amounts: ${sourceAmount} -> ${destAmount}`
      )
    }

    const path = extractPath(records, sourceAsset, destAsset)
    const priceImpactBps = computePriceImpactBps(
      sourceAmountNum,
      destAmountNum,
      records.length
    )
    const destAmountMin = applySlippage(destAmount, slippageBps)

    return {
      sourceAsset,
      sourceAmount,
      destAsset,
      destAmountMin,
      estDestAmount: destAmount,
      path,
      priceImpactBps,
      expiresAt: new Date(Date.now() + ROUTING_QUOTE_TTL_MS),
      highImpact: priceImpactBps > ROUTING_PRICE_IMPACT_WARN_BPS,
    }
  } catch (error) {
    logger.error(`[Routing] Strict-send path finding failed: ${error}`)
    throw error
  }
}

export async function findStrictReceivePath(
  params: Omit<PathPaymentParams, 'sourceAmount'> & { slippageBps?: number }
): Promise<RoutedQuote> {
  const { sourceAsset, destAsset, destAmount } = params
  const slippageBps = clampSlippage(params.slippageBps)

  if (!destAmount) {
    throw new Error('destAmount is required for strict-receive paths')
  }

  parseAsset(sourceAsset)
  parseAsset(destAsset)

  const url = horizonPathFindingUrl('strict-receive', {
    source_asset: sourceAsset,
    dest_asset: destAsset,
    destination_amount: destAmount,
  })

  try {
    const records = await fetchPathRecords(url)
    const record = requireSingleRecord(records, 'strict-receive')

    const sourceAmount = record.source_amount
    if (sourceAmount === undefined) {
      throw new Error(
        'Horizon strict-receive response is missing source_amount'
      )
    }

    const sourceAmountNum = Number(sourceAmount)
    const destAmountNum = Number(destAmount)
    if (!Number.isFinite(sourceAmountNum) || !Number.isFinite(destAmountNum)) {
      throw new Error(
        `Horizon strict-receive returned non-numeric amounts: ${sourceAmount} -> ${destAmount}`
      )
    }

    const path = extractPath(records, sourceAsset, destAsset)
    const priceImpactBps = computePriceImpactBps(
      sourceAmountNum,
      destAmountNum,
      records.length
    )

    // For strict-receive the destination amount is fixed by the caller, so the
    // send amount is what varies: a bigger source_amount means worse impact.
    const destAmountMin = applySlippage(destAmount, slippageBps)

    return {
      sourceAsset,
      sourceAmount,
      destAsset,
      destAmountMin,
      estDestAmount: destAmount,
      path,
      priceImpactBps,
      expiresAt: new Date(Date.now() + ROUTING_QUOTE_TTL_MS),
      highImpact: priceImpactBps > ROUTING_PRICE_IMPACT_WARN_BPS,
    }
  } catch (error) {
    logger.error(`[Routing] Strict-receive path finding failed: ${error}`)
    throw error
  }
}

// ── Quote Validation ────────────────────────────────────────────────────────────

export function validateQuoteExpiry(quote: RoutedQuote): void {
  if (new Date() > quote.expiresAt) {
    throw new Error('routing_quote_expired')
  }
}

export function clampSlippage(slippageBps?: number): number {
  if (slippageBps === undefined) {
    return ROUTING_SLIPPAGE_DEFAULT_BPS
  }
  return Math.max(
    ROUTING_SLIPPAGE_MIN_BPS,
    Math.min(ROUTING_SLIPPAGE_MAX_BPS, slippageBps)
  )
}

// ── Operation Building ───────────────────────────────────────────────────────────

export function buildPathPaymentOp(
  quote: RoutedQuote,
  destination: string,
  slippageBps: number = ROUTING_SLIPPAGE_DEFAULT_BPS
): ReturnType<typeof Operation.pathPaymentStrictSend> {
  const source = parseAsset(quote.sourceAsset)
  const dest = parseAsset(quote.destAsset)

  // Calculate destMin with slippage protection
  const estDest = parseFloat(quote.estDestAmount)
  const slippageFactor = 1 - slippageBps / 10_000
  const destMin = (estDest * slippageFactor).toFixed(7)

  const pathAssets = quote.path.slice(1, -1).map(parseAsset) // Exclude source and dest

  return Operation.pathPaymentStrictSend({
    sendAsset: source,
    sendAmount: quote.sourceAmount,
    destination,
    destAsset: dest,
    destMin,
    path: pathAssets,
  })
}

// ── Exported Configuration ─────────────────────────────────────────────────────

export const ROUTING_CONFIG = {
  QUOTE_TTL_MS: ROUTING_QUOTE_TTL_MS,
  SLIPPAGE_MIN_BPS: ROUTING_SLIPPAGE_MIN_BPS,
  SLIPPAGE_MAX_BPS: ROUTING_SLIPPAGE_MAX_BPS,
  SLIPPAGE_DEFAULT_BPS: ROUTING_SLIPPAGE_DEFAULT_BPS,
  PRICE_IMPACT_WARN_BPS: ROUTING_PRICE_IMPACT_WARN_BPS,
}
