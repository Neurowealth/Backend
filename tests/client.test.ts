/**
 * tests/client.test.ts
 *
 * Tests for ResilientRpcClient failover + circuit-breaker behaviour.
 * Run with:  npx jest tests/client.test.ts
 */

import { jest } from '@jest/globals'

// ── Mock prom-client before any module import ─────────────────────────────────
// Path is relative to THIS file (tests/), so we go ../src/utils/…
jest.mock('../src/utils/rpc-metrics', () => ({
  rpcAttemptCounter: { inc: jest.fn() },
  rpcFailoverCounter: { inc: jest.fn() },
  rpcCircuitOpenCounter: { inc: jest.fn() },
  rpcLatencyHistogram: { startTimer: jest.fn(() => jest.fn()) },
}))

// ── Mock config ───────────────────────────────────────────────────────────────
jest.mock('../src/config', () => ({
  config: {
    stellar: { network: 'testnet', rpcUrl: 'https://primary.example.com' },
    httpClient: {
      timeoutMs: 5_000,
      maxRetries: 1,
      baseDelayMs: 0,
      maxDelayMs: 0,
      circuitBreakerThreshold: 2, // open after 2 failures for fast tests
      circuitBreakerResetMs: 60_000,
    },
  },
}))

// ── Mock @stellar/stellar-sdk ─────────────────────────────────────────────────
// jest.fn() imported from '@jest/globals' infers a narrow return type that collapses
// .mockResolvedValueOnce / .mockRejectedValueOnce arguments to `never`.
// Supplying an explicit generic — jest.fn<(...args: any[]) => any>() — gives the
// mock an open signature so every call to those helpers type-checks correctly.
const mockSendTransaction = jest.fn<(...args: any[]) => any>()
const mockGetAccount = jest.fn<(...args: any[]) => any>()

jest.mock('@stellar/stellar-sdk', () => ({
  rpc: {
    Server: jest.fn().mockImplementation(() => ({
      sendTransaction: mockSendTransaction,
      getAccount: mockGetAccount,
    })),
  },
  Networks: { TESTNET: 'Test SDF Network ; September 2015' },
  Keypair: { fromSecret: jest.fn() },
  Transaction: jest.fn(),
  TransactionBuilder: jest.fn(),
  Account: jest.fn(),
}))

// ── Helpers ───────────────────────────────────────────────────────────────────

function setEnvUrls(urls: string) {
  process.env.STELLAR_RPC_URLS = urls
  delete process.env.STELLAR_RPC_URL
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ResilientRpcClient', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  afterEach(() => {
    delete process.env.STELLAR_RPC_URLS
    delete process.env.STELLAR_RPC_URL
    jest.resetModules()
  })

  describe('primary success', () => {
    it('returns the result from the primary endpoint without failover', async () => {
      mockGetAccount.mockResolvedValueOnce({ id: 'GABC', sequence: '1' })

      setEnvUrls('https://primary.example.com')
      jest.resetModules()
      const { getAccount } = await import('../src/stellar/client')

      const result = await getAccount('GABC')
      expect(result).toEqual({ id: 'GABC', sequence: '1' })
      expect(mockGetAccount).toHaveBeenCalledTimes(1)
    })
  })

  describe('failover on primary failure', () => {
    it('tries secondary endpoint when primary throws', async () => {
      // Primary fails once, secondary succeeds
      mockGetAccount
        .mockRejectedValueOnce(new Error('primary down'))
        .mockResolvedValueOnce({ id: 'GABC', sequence: '2' })

      setEnvUrls('https://primary.example.com,https://secondary.example.com')
      jest.resetModules()
      const { getAccount } = await import('../src/stellar/client')

      const result = await getAccount('GABC')
      expect(result).toEqual({ id: 'GABC', sequence: '2' })
      expect(mockGetAccount).toHaveBeenCalledTimes(2)
    })

    it('throws if ALL endpoints fail', async () => {
      mockGetAccount.mockRejectedValue(new Error('all down'))

      setEnvUrls('https://primary.example.com,https://secondary.example.com')
      jest.resetModules()
      const { getAccount } = await import('../src/stellar/client')

      await expect(getAccount('GABC')).rejects.toThrow('all down')
    })
  })

  describe('circuit breaker open', () => {
    it('skips an endpoint whose circuit breaker is open and falls over', async () => {
      // threshold = 2, so two failures open the breaker
      mockGetAccount
        .mockRejectedValueOnce(new Error('fail 1'))
        .mockRejectedValueOnce(new Error('fail 2'))
        // After circuit opens, second endpoint should be tried
        .mockResolvedValueOnce({ id: 'GABC', sequence: '3' })

      setEnvUrls('https://primary.example.com,https://secondary.example.com')
      jest.resetModules()
      const { getAccount } = await import('../src/stellar/client')

      // First two calls exhaust retries and open the primary circuit
      await expect(getAccount('GABC')).rejects.toThrow()
      await expect(getAccount('GABC')).rejects.toThrow()

      // Third call: primary circuit is open → skipped → secondary succeeds
      const result = await getAccount('GABC')
      expect(result).toEqual({ id: 'GABC', sequence: '3' })
    })
  })

  describe('submitTransaction', () => {
    it('returns hash on PENDING status', async () => {
      mockSendTransaction.mockResolvedValueOnce({ status: 'PENDING', hash: 'abc123' })

      setEnvUrls('https://primary.example.com')
      jest.resetModules()
      const { submitTransaction } = await import('../src/stellar/client')

      const hash = await submitTransaction({} as any)
      expect(hash).toBe('abc123')
    })

    it('throws on ERROR status', async () => {
      mockSendTransaction.mockResolvedValueOnce({
        status: 'ERROR',
        errorResult: { toXDR: () => 'base64err' },
      })

      setEnvUrls('https://primary.example.com')
      jest.resetModules()
      const { submitTransaction } = await import('../src/stellar/client')

      await expect(submitTransaction({} as any)).rejects.toThrow('Transaction failed')
    })
  })

  describe('getRpcHealthSnapshot', () => {
    it('returns state for each configured endpoint', async () => {
      setEnvUrls('https://primary.example.com,https://secondary.example.com')
      jest.resetModules()
      const { getRpcHealthSnapshot } = await import('../src/stellar/client')

      const snap = getRpcHealthSnapshot()
      expect(snap).toHaveLength(2)
      expect(snap[0]).toMatchObject({ url: 'https://primary.example.com', state: 'closed' })
      expect(snap[1]).toMatchObject({ url: 'https://secondary.example.com', state: 'closed' })
    })
  })

  describe('resetRpcCircuitBreakers', () => {
    it('resets all endpoints to closed state', async () => {
      setEnvUrls('https://primary.example.com')
      jest.resetModules()
      const { resetRpcCircuitBreakers, getRpcHealthSnapshot } = await import('../src/stellar/client')

      resetRpcCircuitBreakers()
      const snap = getRpcHealthSnapshot()
      expect(snap.every((e: { state: string }) => e.state === 'closed')).toBe(true)
    })
  })
})