import { MockPriceFeedProvider } from './mockProvider'
import { StellarDexPriceFeedProvider } from './stellarDexProvider'
import { PriceFeedProvider } from './types'

const providers = new Map<string, PriceFeedProvider>()
let activeProviderOverride: PriceFeedProvider | null = null

export function registerPriceFeedProvider(provider: PriceFeedProvider): void {
  providers.set(provider.name.toLowerCase(), provider)
}

function initializeDefaultProviders(): void {
  if (providers.size === 0) {
    registerPriceFeedProvider(new StellarDexPriceFeedProvider())
    registerPriceFeedProvider(new MockPriceFeedProvider())
  }
}

/**
 * Resolve the active PriceFeedProvider.
 *
 * @param name - Optional provider name to retrieve specifically.
 * @returns The resolved PriceFeedProvider.
 */
export function getPriceFeedProvider(name?: string): PriceFeedProvider {
  initializeDefaultProviders()

  if (activeProviderOverride && !name) {
    return activeProviderOverride
  }

  if (name) {
    const provider = providers.get(name.toLowerCase())
    if (!provider) {
      throw new Error(`Unknown price feed provider: "${name}"`)
    }
    return provider
  }

  const configured = process.env.PRICE_FEED_PROVIDER
  if (configured) {
    const provider = providers.get(configured.toLowerCase())
    if (provider) {
      return provider
    }
  }

  if (process.env.NODE_ENV === 'test') {
    return providers.get('mock') || new MockPriceFeedProvider()
  }

  return providers.get('stellar-dex') || new StellarDexPriceFeedProvider()
}

/**
 * Override the active default PriceFeedProvider.
 */
export function setPriceFeedProvider(provider: PriceFeedProvider): void {
  activeProviderOverride = provider
}

/**
 * Reset provider overrides and re-initialize defaults.
 */
export function resetPriceFeedProvider(): void {
  activeProviderOverride = null
  providers.clear()
  initializeDefaultProviders()
}
