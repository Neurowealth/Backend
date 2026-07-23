/**
 * Lightweight readiness tracker.
 *
 * The HTTP server starts listening before the event listener and the agent
 * loop are guaranteed to be up. This module lets index.ts mark each subsystem
 * ready as it boots and lets `/health` return 503 if anything critical is
 * still down — so a load balancer or k8s readiness probe won't send traffic
 * to a half-booted instance.
 */
import { config } from './env'
import { logger } from '../utils/logger'

type Subsystem = 'eventListener' | 'agentLoop' | 'database' | 'stellarNetwork'

interface ReadinessState {
  eventListener: boolean
  agentLoop: boolean
  database: boolean
  stellarNetwork: boolean
}

const state: ReadinessState = {
  eventListener: false,
  agentLoop: false,
  database: false,
  stellarNetwork: false,
}

/**
 * Validate that the configured network is consistent.
 * This catches misconfigurations where a testnet key is used against mainnet RPC
 * or vice versa.
 */
function validateNetworkConsistency(): void {
  const network = config.stellar.network
  const rpcUrl = config.stellar.rpcUrl

  // Check if RPC URL matches the configured network
  const expectedPatterns: Record<string, string[]> = {
    testnet: ['soroban-testnet', 'testnet'],
    mainnet: ['soroban-mainnet', 'mainnet'],
    futurenet: ['soroban-futurenet', 'futurenet'],
  }

  const patterns = expectedPatterns[network]
  if (patterns && !patterns.some((p) => rpcUrl.toLowerCase().includes(p))) {
    logger.warn(
      `⚠️  Network/RPC mismatch: STELLAR_NETWORK=${network} but RPC URL "${rpcUrl}" ` +
        `does not appear to be a ${network} endpoint. Verify your configuration.`
    )
  } else {
    logger.info(`✓ Stellar network consistency validated: ${network}`)
  }
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

/**
 * Initialize network validation at startup.
 * Should be called once during application bootstrap.
 */
export function validateStellarNetworkReady(): void {
  try {
    validateNetworkConsistency()
    markReady('stellarNetwork')
  } catch (error) {
    logger.error('Stellar network validation failed:', error)
    markNotReady('stellarNetwork')
  }
}
