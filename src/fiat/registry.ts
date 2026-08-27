/**
 * Fiat provider registry (#290, extended #313 for multi-provider resilience).
 *
 * The single lookup point that maps a provider key to a {@link FiatRampProvider}
 * implementation. Route handlers and the reconciliation service resolve
 * providers exclusively through here, so adding a vendor is a one-line
 * registry change with no edits to call sites.
 *
 * On top of the plain lookup, the registry now keeps a per-provider health
 * ledger with circuit-breaker semantics matching {@link
 * ../utils/http-client.ts} (closed → open after N consecutive failures →
 * half-open after a reset window), and a selection policy so callers can ask
 * for "the default provider", "the best-quoting provider", "the next healthy
 * provider in rotation", or "my preferred provider, if it's up".
 *
 * `getDefaultProvider()` still returns the configured active provider for new
 * orders; `getProvider(name)` resolves the provider a stored order was created
 * with, so webhooks/reconciliation always use the same vendor that opened the
 * order — failover only ever applies to picking a provider for a *new* order,
 * never to an order already in flight.
 */
import { setFiatProviderCircuitState } from '../utils/metrics'
import {
  CircuitState,
  FiatRampProvider,
  NoHealthyProvidersError,
  ProviderHealthSnapshot,
  ProviderSelectionPolicy,
} from './types'
import { MoonPayProvider } from './providers/moonpay'
import { SandboxProvider } from './providers/sandbox'

const registry = new Map<string, FiatRampProvider>()

// ── Health ledger ─────────────────────────────────────────────────────────────

interface HealthState {
  state: CircuitState
  consecutiveFailures: number
  totalSuccess: number
  totalFailure: number
  lastFailureAt: number | null
  lastSuccessAt: number | null
}

const CIRCUIT_BREAKER_THRESHOLD = Number(
  process.env.FIAT_PROVIDER_CIRCUIT_BREAKER_THRESHOLD || 5
)
const CIRCUIT_BREAKER_RESET_MS = Number(
  process.env.FIAT_PROVIDER_CIRCUIT_BREAKER_RESET_MS || 30_000
)

const health = new Map<string, HealthState>()
let roundRobinCursor = 0

function freshHealth(): HealthState {
  return {
    state: 'closed',
    consecutiveFailures: 0,
    totalSuccess: 0,
    totalFailure: 0,
    lastFailureAt: null,
    lastSuccessAt: null,
  }
}

function healthFor(name: string): HealthState {
  let h = health.get(name)
  if (!h) {
    h = freshHealth()
    health.set(name, h)
  }
  return h
}

/** Resolve a half-open transition lazily, mirroring HttpClientAdapter. */
function refreshCircuitState(name: string): HealthState {
  const h = healthFor(name)
  if (
    h.state === 'open' &&
    h.lastFailureAt !== null &&
    Date.now() - h.lastFailureAt >= CIRCUIT_BREAKER_RESET_MS
  ) {
    h.state = 'half-open'
    setFiatProviderCircuitState(name, 'half-open')
  }
  return h
}

/** Record a successful provider call (quote or order creation). */
export function recordProviderSuccess(name: string): void {
  const h = healthFor(name)
  h.totalSuccess++
  h.consecutiveFailures = 0
  h.lastSuccessAt = Date.now()
  h.state = 'closed'
  setFiatProviderCircuitState(name, 'closed')
}

/** Record a failed provider call (quote or order creation). */
export function recordProviderFailure(name: string): void {
  const h = healthFor(name)
  h.totalFailure++
  h.consecutiveFailures++
  h.lastFailureAt = Date.now()
  if (h.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
    h.state = 'open'
    setFiatProviderCircuitState(name, 'open')
  }
}

/** Whether a provider is currently eligible for new quote/order traffic. */
export function isProviderHealthy(name: string): boolean {
  return refreshCircuitState(name).state !== 'open'
}

export function getProviderHealth(name: string): ProviderHealthSnapshot {
  const h = refreshCircuitState(name)
  return {
    provider: name,
    state: h.state,
    consecutiveFailures: h.consecutiveFailures,
    totalSuccess: h.totalSuccess,
    totalFailure: h.totalFailure,
    lastFailureAt: h.lastFailureAt
      ? new Date(h.lastFailureAt).toISOString()
      : null,
    lastSuccessAt: h.lastSuccessAt
      ? new Date(h.lastSuccessAt).toISOString()
      : null,
    healthy: h.state !== 'open',
  }
}

export function getAllProviderHealth(): ProviderHealthSnapshot[] {
  return Array.from(registry.keys()).map(getProviderHealth)
}

/**
 * Admin/operator override (#313): force a provider's circuit open (manual
 * failover) or closed (manual recovery). Bypasses the failure-count threshold
 * so operators can react before the automatic breaker would trip/reset.
 */
export function adminSetProviderCircuit(
  name: string,
  state: 'open' | 'closed'
): ProviderHealthSnapshot {
  if (!registry.has(name)) {
    throw new Error(`Unknown fiat provider: "${name}"`)
  }
  const h = healthFor(name)
  h.state = state
  if (state === 'closed') {
    h.consecutiveFailures = 0
  }
  setFiatProviderCircuitState(name, state)
  return getProviderHealth(name)
}

// ── Registration ────────────────────────────────────────────────────────────

function register(provider: FiatRampProvider): void {
  registry.set(provider.name, provider)
  if (!health.has(provider.name)) {
    health.set(provider.name, freshHealth())
  }
}

register(new MoonPayProvider())

// The sandbox provider is a documented, deterministic second implementation
// proving the multi-provider abstraction actually works end-to-end (#313). It
// is registered by default outside production; set FIAT_ENABLE_SANDBOX_PROVIDER
// explicitly to control it in any environment.
const sandboxFlag = process.env.FIAT_ENABLE_SANDBOX_PROVIDER
const sandboxEnabled =
  sandboxFlag != null
    ? sandboxFlag === 'true'
    : process.env.NODE_ENV !== 'production'
if (sandboxEnabled) {
  register(new SandboxProvider())
}

/** The provider key used for newly created orders absent any other signal. */
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

/** Resolve the active default provider for new orders (ignores health). */
export function getDefaultProvider(): FiatRampProvider {
  return getProvider(defaultProviderName())
}

/** All registered providers, healthy or not. */
export function getAllProviders(): FiatRampProvider[] {
  return Array.from(registry.values())
}

/** Providers currently eligible for new traffic (circuit not open). */
export function getHealthyProviders(): FiatRampProvider[] {
  return getAllProviders().filter((p) => isProviderHealthy(p.name))
}

export interface SelectProviderOptions {
  policy?: ProviderSelectionPolicy
  /** Required for PREFER_PROVIDER; used as a tiebreak hint for BEST_QUOTE callers that already resolved one. */
  preferredProvider?: string
}

/**
 * Resolve a single provider for a *new* order/quote per the requested
 * selection policy. Never returns an unhealthy provider unless it is the last
 * one left in the registry (better to try and surface the provider's own
 * error than to hard-fail before attempting anything).
 *
 * BEST_QUOTE cannot be resolved here in isolation — it requires comparing
 * live quotes — so callers using that policy should run the best-execution
 * quote flow (see `fiat/service.ts`) and pass the winning provider name back
 * in as PREFER_PROVIDER, or rely on a `quoteId` which already pins a provider.
 */
export function selectProviderForOrder(
  opts: SelectProviderOptions = {}
): FiatRampProvider {
  const policy = opts.policy ?? 'DEFAULT'
  const healthy = getHealthyProviders()

  if (healthy.length === 0) {
    throw new NoHealthyProvidersError(
      getAllProviderHealth().map((h) => ({
        provider: h.provider,
        reason: `circuit ${h.state} after ${h.consecutiveFailures} consecutive failures`,
      }))
    )
  }

  if (policy === 'PREFER_PROVIDER' && opts.preferredProvider) {
    const preferred = healthy.find((p) => p.name === opts.preferredProvider)
    if (preferred) return preferred
    // Preferred provider is unhealthy/unknown among healthy ones — fall through
    // to DEFAULT semantics rather than failing the whole request.
  }

  if (policy === 'ROUND_ROBIN_HEALTHY') {
    const provider = healthy[roundRobinCursor % healthy.length]
    roundRobinCursor = (roundRobinCursor + 1) % healthy.length
    return provider
  }

  // DEFAULT and BEST_QUOTE (as a fallback when the caller hasn't already
  // resolved a winner) both prefer the configured default provider when it's
  // healthy, and otherwise fail over to the first healthy alternative.
  const preferredDefault = healthy.find((p) => p.name === defaultProviderName())
  return preferredDefault ?? healthy[0]
}

/**
 * Test/bootstrap seam: replace or add a provider implementation. Used by unit
 * tests to inject a stub without going through env configuration.
 */
export function registerProvider(provider: FiatRampProvider): void {
  register(provider)
}

/** Test seam: reset all provider health state back to closed/zeroed. */
export function resetProviderHealth(): void {
  health.clear()
  roundRobinCursor = 0
  for (const name of registry.keys()) {
    health.set(name, freshHealth())
  }
}
