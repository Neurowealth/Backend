/**
 * src/stellar/routing.ts
 *
 * Path-payment routing primitives for DEX auto-routing.
 * Provides strict-send and strict-receive path finding with slippage protection.
 */

import { Asset, Operation, TransactionBuilder } from '@stellar/stellar-sdk'
import { getResilientClient } from './client'
import { getNetworkPassphrase } from './client'
import { logger } from '../utils/logger'

// ── Configuration ───────────────────────────────────────────────────────────────

const ROUTING_QUOTE_TTL_MS = 30_000 // 30 seconds
const ROUTING_SLIPPAGE_MIN_BPS = 10 // 0.1%
const ROUTING_SLIPPAGE_MAX_BPS = 300 // 3%
const ROUTING_SLIPPAGE_DEFAULT_BPS = 50 // 0.5%
const ROUTING_PRICE_IMPACT_WARN_BPS = 100 // 1%

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

// ── Path Finding ───────────────────────────────────────────────────────────────

export async function findStrictSendPath(
  params: Omit<PathPaymentParams, 'slippageBps'>
): Promise<RoutedQuote> {
  const { sourceAsset, sourceAmount, destAsset } = params

  const source = parseAsset(sourceAsset)
  const dest = parseAsset(destAsset)

  try {
    // Minimal implementation - Stellar SDK path finding requires Horizon server
    // For now, return a direct path (no conversion)
    const expiresAt = new Date(Date.now() + ROUTING_QUOTE_TTL_MS)

    return {
      sourceAsset,
      sourceAmount,
      destAsset,
      destAmountMin: sourceAmount, // No conversion in minimal implementation
      estDestAmount: sourceAmount,
      path: [],
      priceImpactBps: 0,
      expiresAt,
      highImpact: false,
    }
  } catch (error) {
    logger.error(`[Routing] Strict-send path finding failed: ${error}`)
    throw error
  }
}

export async function findStrictReceivePath(
  params: Omit<PathPaymentParams, 'sourceAmount'>
): Promise<RoutedQuote> {
  const { sourceAsset, destAsset, destAmount } = params

  if (!destAmount) {
    throw new Error('destAmount is required for strict-receive paths')
  }

  const source = parseAsset(sourceAsset)
  const dest = parseAsset(destAsset)

  try {
    // Minimal implementation - Stellar SDK path finding requires Horizon server
    // For now, return a direct path (no conversion)
    const expiresAt = new Date(Date.now() + ROUTING_QUOTE_TTL_MS)

    return {
      sourceAsset,
      sourceAmount: destAmount, // No conversion in minimal implementation
      destAsset,
      destAmountMin: destAmount,
      estDestAmount: destAmount,
      path: [],
      priceImpactBps: 0,
      expiresAt,
      highImpact: false,
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
): Operation {
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
