/**
 * Fiat provider registry (#290).
 *
 * The single lookup point that maps a provider key to a {@link FiatRampProvider}
 * implementation. Route handlers and the reconciliation service resolve
 * providers exclusively through here, so adding a second vendor is a one-line
 * registry change with no edits to call sites.
 *
 * `getDefaultProvider()` returns the configured active provider for new orders;
 * `getProvider(name)` resolves the provider a stored order was created with, so
 * webhooks/reconciliation always use the same vendor that opened the order.
 */
import { FiatRampProvider } from './types'
import { MoonPayProvider } from './providers/moonpay'

const registry = new Map<string, FiatRampProvider>()

function register(provider: FiatRampProvider): void {
  registry.set(provider.name, provider)
}

// v1 ships a single provider. Add further vendors here — nothing else changes.
register(new MoonPayProvider())

/** The provider key used for newly created orders. */
export function defaultProviderName(): string {
  return process.env.FIAT_DEFAULT_PROVIDER || 'moonpay'
}

/** Resolve a provider by key. Throws if the key is unknown/unconfigured. */
export function getProvider(name: string): FiatRampProvider {
  const provider = registry.get(name)
  if (!provider) {
    throw new Error(`Unknown fiat provider: "${name}"`)
  }
  return provider
}

/** Resolve the active default provider for new orders. */
export function getDefaultProvider(): FiatRampProvider {
  return getProvider(defaultProviderName())
}

/**
 * Test/bootstrap seam: replace or add a provider implementation. Used by unit
 * tests to inject a stub without going through env configuration.
 */
export function registerProvider(provider: FiatRampProvider): void {
  register(provider)
}
