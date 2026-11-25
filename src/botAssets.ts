/**
 * Supported asset validation for chat-bot financial intents (#926).
 *
 * Kept separate from src/botWithdrawals.ts so handler unit tests that mock
 * botWithdrawals can still run the real asset validation without partial-mock
 * surprises, and Telegram/WhatsApp share one canonical asset list.
 */

export const DEFAULT_BOT_ASSET = 'XLM'

export const SUPPORTED_BOT_ASSETS: ReadonlySet<string> = new Set([
  'XLM',
  'USDC',
])

export type AssetResolution =
  | { ok: true; assetSymbol: string }
  | { ok: false; assetSymbol: string }

/**
 * Normalize and validate an optional bot currency/asset symbol.
 * An omitted or blank currency defaults to XLM; any explicit non-empty value
 * must be in SUPPORTED_BOT_ASSETS.
 */
export function resolveBotAsset(currency?: string): AssetResolution {
  const trimmed = currency?.trim()
  if (!trimmed) {
    return { ok: true, assetSymbol: DEFAULT_BOT_ASSET }
  }
  const normalized = trimmed.toUpperCase()
  if (!SUPPORTED_BOT_ASSETS.has(normalized)) {
    return { ok: false, assetSymbol: normalized }
  }
  return { ok: true, assetSymbol: normalized }
}

export function formatUnsupportedAssetMessage(assetSymbol: string): string {
  const display = assetSymbol.trim().toUpperCase() || 'UNKNOWN'
  const supported = Array.from(SUPPORTED_BOT_ASSETS).join(', ')
  return `Unsupported asset "${display}". Supported assets are: ${supported}.`
}
