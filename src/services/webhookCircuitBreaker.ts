/**
 * Per-subscription webhook circuit breaker (#377).
 * Mirrors fiat/registry.ts health-ledger semantics.
 */

export type WebhookCircuitState = 'closed' | 'open' | 'half_open'

interface CircuitHealth {
  state: WebhookCircuitState
  consecutiveFailures: number
  openedUntil: number | null
  lastFailureAt: number | null
}

const THRESHOLD = Number(process.env.WEBHOOK_CIRCUIT_BREAKER_THRESHOLD || 5)
const RESET_MS = Number(process.env.WEBHOOK_CIRCUIT_BREAKER_RESET_MS || 60_000)
const AUTO_DISABLE_HOURS = Number(process.env.WEBHOOK_AUTO_DISABLE_HOURS || 24)

const health = new Map<string, CircuitHealth>()

function fresh(): CircuitHealth {
  return {
    state: 'closed',
    consecutiveFailures: 0,
    openedUntil: null,
    lastFailureAt: null,
  }
}

function getHealth(subscriptionId: string): CircuitHealth {
  let h = health.get(subscriptionId)
  if (!h) {
    h = fresh()
    health.set(subscriptionId, h)
  }
  return h
}

function refreshState(h: CircuitHealth): void {
  if (
    h.state === 'open' &&
    h.openedUntil !== null &&
    Date.now() >= h.openedUntil
  ) {
    h.state = 'half_open'
  }
}

export function isSubscriptionDeliverable(subscriptionId: string): boolean {
  const h = getHealth(subscriptionId)
  refreshState(h)
  return h.state !== 'open'
}

export function recordDeliverySuccess(subscriptionId: string): void {
  const h = getHealth(subscriptionId)
  h.consecutiveFailures = 0
  h.state = 'closed'
  h.openedUntil = null
}

export function recordDeliveryFailure(
  subscriptionId: string
): WebhookCircuitState {
  const h = getHealth(subscriptionId)
  h.consecutiveFailures++
  h.lastFailureAt = Date.now()

  if (h.consecutiveFailures >= THRESHOLD) {
    h.state = 'open'
    h.openedUntil = Date.now() + RESET_MS
  }
  return h.state
}

export function recordHalfOpenProbe(
  subscriptionId: string,
  success: boolean
): void {
  const h = getHealth(subscriptionId)
  if (success) {
    h.state = 'closed'
    h.consecutiveFailures = 0
    h.openedUntil = null
  } else {
    h.state = 'open'
    h.openedUntil = Date.now() + RESET_MS
  }
}

export function getSubscriptionHealth(subscriptionId: string): CircuitHealth & {
  shouldAutoDisable: boolean
} {
  const h = getHealth(subscriptionId)
  refreshState(h)
  const shouldAutoDisable =
    h.state === 'open' &&
    h.lastFailureAt !== null &&
    Date.now() - h.lastFailureAt >= AUTO_DISABLE_HOURS * 60 * 60 * 1000
  return { ...h, shouldAutoDisable }
}

export function resetSubscriptionHealth(subscriptionId: string): void {
  health.set(subscriptionId, fresh())
}

/** Test seam */
export function _clearAllHealth(): void {
  health.clear()
}
