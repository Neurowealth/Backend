/**
 * Lightweight readiness tracker.
 *
 * The HTTP server starts listening before the event listener and the agent
 * loop are guaranteed to be up. This module lets index.ts mark each subsystem
 * ready as it boots and lets `/health` return 503 if anything critical is
 * still down — so a load balancer or k8s readiness probe won't send traffic
 * to a half-booted instance.
 */
type Subsystem = 'eventListener' | 'agentLoop' | 'database'

interface ReadinessState {
  eventListener: boolean
  agentLoop: boolean
  database: boolean
}

const state: ReadinessState = {
  eventListener: false,
  agentLoop: false,
  database: false,
}

export function markReady(subsystem: Subsystem): void {
  state[subsystem] = true
}

export function markNotReady(subsystem: Subsystem): void {
  state[subsystem] = false
}

export function getReadiness(): {
  ready: boolean
  subsystems: ReadinessState
} {
  const ready = Object.values(state).every((v) => v)
  return { ready, subsystems: { ...state } }
}
