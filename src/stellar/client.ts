/**
 * src/stellar/client.ts
 *
 * Resilient Stellar RPC client with:
 *  - Multi-endpoint failover (STELLAR_RPC_URLS, comma-separated)
 *  - Per-endpoint circuit breaker via HttpClientAdapter
 *  - Prometheus metrics for RPC health
 *  - Backward-compatible single-URL support (STELLAR_RPC_URL)
 */

import {
  rpc,
  Keypair,
  Networks,
  Transaction,
  Account,
} from '@stellar/stellar-sdk'
import { config } from '../config'
import { HttpClientAdapter, TimeoutError } from '../utils/http-client'
import { logger } from '../utils/logger'
import { TransactionConfirmationTimeoutError, TransactionResult } from './types'
import { fetchWithRetry } from '../utils/fetchWithRetry'
import {
  ExternalWalletBalance,
  normalizeExternalWalletBalances,
} from './externalWalletBalances'
import {
  rpcAttemptCounter,
  rpcFailoverCounter,
  rpcCircuitOpenCounter,
  rpcLatencyHistogram,
} from '../utils/rpc-metrics'

// ── Network passphrase ────────────────────────────────────────────────────────

export function resolveNetworkPassphrase(network: string | undefined): string {
  switch (network?.toLowerCase()) {
    case 'mainnet':
      return Networks.PUBLIC
    case 'testnet':
      return Networks.TESTNET
    case 'futurenet':
      return Networks.FUTURENET
    default:
      throw new Error(
        `Unknown STELLAR_NETWORK: "${network}". Expected "mainnet", "testnet", or "futurenet".`
      )
  }
}

const NETWORK_PASSPHRASE = resolveNetworkPassphrase(config.stellar.network)

export function getNetworkPassphrase(): string {
  return NETWORK_PASSPHRASE
}

// ── RPC URL list ──────────────────────────────────────────────────────────────
//
// Priority order:
//   1. STELLAR_RPC_URLS  (comma-separated list, e.g. "https://a.com,https://b.com")
//   2. STELLAR_RPC_URL   (single legacy env var, kept for backward compat)
//   3. config.stellar.rpcUrl

function resolveRpcUrls(): string[] {
  const multi = process.env.STELLAR_RPC_URLS
  if (multi) {
    const urls = multi
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean)
    if (urls.length > 0) return urls
  }

  const single = process.env.STELLAR_RPC_URL ?? config.stellar.rpcUrl
  if (single) return [single]

  throw new Error(
    'No Stellar RPC URL configured. Set STELLAR_RPC_URLS or STELLAR_RPC_URL.'
  )
}

// ── Per-endpoint state ────────────────────────────────────────────────────────

interface EndpointSlot {
  url: string
  server: rpc.Server
  adapter: HttpClientAdapter
}

function buildSlots(urls: string[]): EndpointSlot[] {
  return urls.map((url) => ({
    url,
    server: new rpc.Server(url),
    adapter: new HttpClientAdapter({
      timeoutMs: config.httpClient.timeoutMs,
      maxRetries: config.httpClient.maxRetries,
      baseDelayMs: config.httpClient.baseDelayMs,
      maxDelayMs: config.httpClient.maxDelayMs,
      circuitBreakerThreshold: config.httpClient.circuitBreakerThreshold,
      circuitBreakerResetMs: config.httpClient.circuitBreakerResetMs,
    }),
  }))
}

// ── ResilientRpcClient ────────────────────────────────────────────────────────

/**
 * Wraps multiple RPC endpoints. On each call it tries the primary endpoint
 * first; if that throws (or its circuit breaker is open) it rotates through
 * the remaining endpoints. Each endpoint has its own HttpClientAdapter so
 * failures are isolated.
 */
class ResilientRpcClient {
  private slots: EndpointSlot[]

  constructor(urls: string[]) {
    if (urls.length === 0)
      throw new Error('ResilientRpcClient requires at least one URL')
    this.slots = buildSlots(urls)
    logger.info(
      `[StellarRPC] Initialized with ${urls.length} endpoint(s): ${urls.join(', ')}`
    )
  }

  /** Run fn against each endpoint in order, stopping at first success. */
  async execute<T>(
    fn: (server: rpc.Server) => Promise<T>,
    context: string
  ): Promise<T> {
    let lastError: Error | undefined

    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i]
      const isPrimary = i === 0

      if (i > 0) {
        rpcFailoverCounter.inc({ endpoint: slot.url, context })
        logger.warn(
          `[StellarRPC] Failing over to endpoint #${i + 1} (${slot.url}) for "${context}"`
        )
      }

      const cbState = slot.adapter.getState().state
      if (cbState === 'open') {
        rpcCircuitOpenCounter.inc({ endpoint: slot.url, context })
        logger.warn(
          `[StellarRPC] Circuit breaker OPEN for ${slot.url}, skipping for "${context}"`
        )
        lastError = new Error(`Circuit breaker open for ${slot.url}`)
        continue
      }

      rpcAttemptCounter.inc({
        endpoint: slot.url,
        context,
        primary: String(isPrimary),
      })
      const endTimer = rpcLatencyHistogram.startTimer({
        endpoint: slot.url,
        context,
      })

      try {
        const result = await slot.adapter.execute(
          () => fn(slot.server),
          context
        )
        endTimer({ success: 'true' })
        return result
      } catch (error) {
        endTimer({ success: 'false' })
        lastError = error instanceof Error ? error : new Error(String(error))
        logger.warn(
          `[StellarRPC] Endpoint ${slot.url} failed for "${context}": ${lastError.message}`
        )
      }
    }

    throw lastError ?? new Error(`All RPC endpoints failed for "${context}"`)
  }

  /** Expose underlying servers (for advanced callers that need direct access). */
  getPrimaryServer(): rpc.Server {
    return this.slots[0].server
  }

  /** Health snapshot for diagnostics. */
  getHealthSnapshot(): Array<{ url: string; state: string; failures: number }> {
    return this.slots.map((s) => ({
      url: s.url,
      ...s.adapter.getState(),
    }))
  }

  /** Reset all circuit breakers (e.g. after operator confirms endpoints are healthy). */
  resetAll(): void {
    this.slots.forEach((s) => s.adapter.reset())
    logger.info('[StellarRPC] All circuit breakers reset')
  }
}

// ── Singletons ────────────────────────────────────────────────────────────────

let resilientClient: ResilientRpcClient | null = null

export function getResilientClient(): ResilientRpcClient {
  if (!resilientClient) {
    resilientClient = new ResilientRpcClient(resolveRpcUrls())
  }
  return resilientClient
}

/**
 * @deprecated Prefer getResilientClient() for new code.
 * Kept for callers that need a raw rpc.Server reference (e.g. legacy event listener).
 */
export function getRpcServer(): rpc.Server {
  return getResilientClient().getPrimaryServer()
}

// ── Agent keypair ─────────────────────────────────────────────────────────────

let agentKeypair: Keypair | null = null

export function getAgentKeypair(): Keypair {
  if (!agentKeypair) {
    const secret = process.env.STELLAR_AGENT_SECRET_KEY
    if (!secret) throw new Error('STELLAR_AGENT_SECRET_KEY not configured')
    agentKeypair = Keypair.fromSecret(secret)
  }
  return agentKeypair
}

// ── Public RPC helpers ────────────────────────────────────────────────────────

export async function submitTransaction(tx: Transaction): Promise<string> {
  return getResilientClient().execute(async (server) => {
    const response = await server.sendTransaction(tx)
    if (response.status === 'ERROR') {
      throw new Error(
        `Transaction failed: ${response.errorResult?.toXDR('base64')}`
      )
    }
    return response.hash
  }, 'stellar.submitTransaction')
}

export async function simulateTransaction(
  tx: Transaction
): Promise<rpc.Api.SimulateTransactionResponse> {
  return getResilientClient().execute(
    (server) => server.simulateTransaction(tx),
    'stellar.simulateTransaction'
  )
}

export async function prepareTransaction(
  tx: Transaction
): Promise<Transaction> {
  return getResilientClient().execute(
    (server) => server.prepareTransaction(tx) as Promise<Transaction>,
    'stellar.prepareTransaction'
  )
}

export async function getAccount(publicKey: string): Promise<Account> {
  return getResilientClient().execute(
    (server) => server.getAccount(publicKey),
    'stellar.getAccount'
  )
}

const MAX_EXTERNAL_WALLET_RESPONSE_BYTES = 128 * 1024

function horizonBaseUrl(): string {
  const configured = process.env.HORIZON_URL
  if (configured) return configured.replace(/\/+$/, '')

  switch (config.stellar.network.toLowerCase()) {
    case 'testnet':
      return 'https://horizon-testnet.stellar.org'
    case 'futurenet':
      return 'https://horizon-futurenet.stellar.org'
    default:
      return 'https://horizon.stellar.org'
  }
}

/** Read-only Horizon snapshot. Oversized accounts fail closed; never truncate. */
export async function getExternalWalletBalances(
  publicKey: string
): Promise<ExternalWalletBalance[]> {
  const url = `${horizonBaseUrl()}/accounts/${encodeURIComponent(publicKey)}`
  const account = await fetchWithRetry(url, {
    timeout: 5_000,
    retries: 2,
    maxResponseBytes: MAX_EXTERNAL_WALLET_RESPONSE_BYTES,
  })

  if (!Array.isArray(account?.balances)) {
    throw new Error('Horizon account response omitted balances')
  }

  return normalizeExternalWalletBalances(account.balances)
}

export async function waitForConfirmation(
  txHash: string,
  timeoutMs: number = 30_000,
  pollIntervalMs: number = 1_000
): Promise<TransactionResult> {
  const pollDeadline = Date.now() + timeoutMs

  // Polling uses the resilient client so individual poll failures also
  // benefit from per-endpoint circuit breaking.
  let lastError: unknown
  do {
    try {
      const response = await getResilientClient().execute(
        (server) => server.getTransaction(txHash),
        'stellar.waitForConfirmation'
      )

      if (response.status === 'SUCCESS') {
        return { hash: txHash, status: 'success', ledger: response.ledger }
      }

      if (response.status === 'FAILED') {
        return { hash: txHash, status: 'failed' }
      }

      lastError = undefined
    } catch (error) {
      lastError = error
    }

    const remainingMs = pollDeadline - Date.now()
    if (remainingMs <= 0) break
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(pollIntervalMs, remainingMs))
    )
  } while (Date.now() <= pollDeadline)

  throw new TransactionConfirmationTimeoutError(txHash, timeoutMs, lastError)
}

export async function getTransactionStatus(
  txHash: string
): Promise<'success' | 'failed' | 'not_found'> {
  const response = await getResilientClient().execute(
    (server) => server.getTransaction(txHash),
    'stellar.getTransactionStatus'
  )

  switch (response.status) {
    case 'SUCCESS':
      return 'success'
    case 'FAILED':
      return 'failed'
    case 'NOT_FOUND':
      return 'not_found'
    default:
      throw new Error(
        `Unexpected Stellar transaction status: ${response.status}`
      )
  }
}

/** Diagnostic helper — returns circuit-breaker state for all endpoints. */
export function getRpcHealthSnapshot() {
  return getResilientClient().getHealthSnapshot()
}

/** Operator escape-hatch — reset all circuit breakers without restarting. */
export function resetRpcCircuitBreakers(): void {
  getResilientClient().resetAll()
}
