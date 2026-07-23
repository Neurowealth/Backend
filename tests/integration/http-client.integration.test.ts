import {
  HttpClientAdapter,
  CircuitBreakerError,
  TimeoutError,
} from '../../src/utils/http-client'

describe('HttpClientAdapter Integration — simulated failures', () => {
  let adapter: HttpClientAdapter

  beforeEach(() => {
    adapter = new HttpClientAdapter({
      timeoutMs: 500,
      maxRetries: 2,
      baseDelayMs: 10,
      maxDelayMs: 100,
      circuitBreakerThreshold: 3,
      circuitBreakerResetMs: 200,
    })
  })

  describe('transient failures — retry recovers', () => {
    it('should succeed after intermittent HTTP 5xx errors', async () => {
      let callCount = 0

      const simulateFlakyApi = async (): Promise<string> => {
        callCount++
        if (callCount <= 2) {
          throw new Error('HTTP 503 Service Unavailable')
        }
        return 'OK'
      }

      const result = await adapter.execute(simulateFlakyApi, 'flakyApi.getData')
      expect(result).toBe('OK')
      expect(callCount).toBe(3)
    })

    it('should succeed after intermittent network timeouts', async () => {
      let callCount = 0

      const simulateTimeoutThenSuccess = async (): Promise<string> => {
        callCount++
        if (callCount <= 1) {
          await new Promise((r) => setTimeout(r, 600))
          throw new TimeoutError(500, 'simulated')
        }
        return 'data'
      }

      const result = await adapter.execute(
        simulateTimeoutThenSuccess,
        'timeoutApi.fetch'
      )
      expect(result).toBe('data')
      expect(callCount).toBe(2)
    })
  })

  describe('persistent failures — circuit breaker opens', () => {
    it('should open circuit after consecutive failures', async () => {
      const simulateDownstream = jest
        .fn()
        .mockRejectedValue(new Error('HTTP 502 Bad Gateway'))

      // First execute exhausts all retries (1 initial + 2 retries = 3 failures)
      // After 3 failures circuit breaker opens
      await expect(
        adapter.execute(simulateDownstream, 'downstreamApi.call')
      ).rejects.toThrow('HTTP 502 Bad Gateway')

      // Circuit is now OPEN — subsequent calls throw CircuitBreakerError
      await expect(
        adapter.execute(simulateDownstream, 'downstreamApi.call')
      ).rejects.toThrow(CircuitBreakerError)

      await expect(
        adapter.execute(simulateDownstream, 'downstreamApi.call')
      ).rejects.toThrow(CircuitBreakerError)

      // Only the first execute made actual attempts (3 = initial + 2 retries)
      expect(simulateDownstream).toHaveBeenCalledTimes(3)
    })

    it('should block requests with CircuitBreakerError after threshold', async () => {
      const simulateDownstream = jest
        .fn()
        .mockRejectedValue(new Error('Service Down'))

      // Exhaust all retries for first execute (should consume all 3 failure slots)
      await expect(
        adapter.execute(simulateDownstream, 'downstreamApi.call')
      ).rejects.toThrow('Service Down')

      // Circuit is now OPEN or at least last failure count high enough
      // that subsequent calls should be blocked
      await expect(
        adapter.execute(simulateDownstream, 'downstreamApi.call')
      ).rejects.toThrow(CircuitBreakerError)

      // Still open
      await expect(
        adapter.execute(simulateDownstream, 'downstreamApi.call')
      ).rejects.toThrow(CircuitBreakerError)
    })

    it('should recover after circuit breaker reset timeout', async () => {
      const mock = jest.fn()

      // Trip the circuit breaker
      mock.mockRejectedValue(new Error('fail'))
      await expect(
        adapter.execute(mock, 'recoverableApi.call')
      ).rejects.toThrow()

      // Circuit is OPEN
      await expect(
        adapter.execute(mock, 'recoverableApi.call')
      ).rejects.toThrow(CircuitBreakerError)

      // Wait for reset
      jest.useFakeTimers()
      jest.advanceTimersByTime(300)

      // Service recovers — should succeed in half-open state
      mock.mockResolvedValue('recovered')
      const result = await adapter.execute(mock, 'recoverableApi.call')
      expect(result).toBe('recovered')

      jest.useRealTimers()
    })
  })

  describe('timeout behavior', () => {
    it('should timeout slow responses and fall back after retry', async () => {
      const fastTimeoutAdapter = new HttpClientAdapter({
        timeoutMs: 30,
        maxRetries: 1,
        baseDelayMs: 10,
        maxDelayMs: 50,
        circuitBreakerThreshold: 10,
        circuitBreakerResetMs: 1000,
      })

      let callCount = 0

      const simulateSlowThenFast = async (): Promise<string> => {
        callCount++
        if (callCount <= 1) {
          await new Promise((r) => setTimeout(r, 100))
          throw new TimeoutError(30, 'simulated')
        }
        return 'fast response'
      }

      const result = await fastTimeoutAdapter.execute(
        simulateSlowThenFast,
        'slowApi.get'
      )
      expect(result).toBe('fast response')
      expect(callCount).toBe(2)
    })
  })

  describe('mixed failure modes', () => {
    it('should handle timeout then HTTP error then success via retries', async () => {
      const mixedAdapter = new HttpClientAdapter({
        timeoutMs: 50,
        maxRetries: 3,
        baseDelayMs: 10,
        maxDelayMs: 50,
        circuitBreakerThreshold: 10,
        circuitBreakerResetMs: 1000,
      })

      let callCount = 0

      const simulateChaoticApi = async (): Promise<string> => {
        callCount++
        switch (callCount) {
          case 1:
            await new Promise((r) => setTimeout(r, 100))
            throw new TimeoutError(50, 'simulated timeout')
          case 2:
            throw new Error('HTTP 500 Internal Server Error')
          case 3:
            return 'success after chaos'
          default:
            throw new Error('unexpected call')
        }
      }

      const result = await mixedAdapter.execute(
        simulateChaoticApi,
        'chaoticApi.fetch'
      )
      expect(result).toBe('success after chaos')
      expect(callCount).toBe(3)
    })
  })

  describe('Stellar client scenario', () => {
    it('should retry Stellar RPC failures and circuit-break after threshold', async () => {
      const stellarAdapter = new HttpClientAdapter({
        timeoutMs: 100,
        maxRetries: 2,
        baseDelayMs: 10,
        maxDelayMs: 50,
        circuitBreakerThreshold: 3,
        circuitBreakerResetMs: 500,
      })

      const simulateStellarRpc = jest.fn()

      // Simulate persistent submission failure
      simulateStellarRpc.mockRejectedValue(new Error('stellar rpc: timeout'))
      await expect(
        stellarAdapter.execute(simulateStellarRpc, 'stellar.submitTransaction')
      ).rejects.toThrow('stellar rpc: timeout')

      // Still failing
      await expect(
        stellarAdapter.execute(simulateStellarRpc, 'stellar.submitTransaction')
      ).rejects.toThrow(CircuitBreakerError)

      // After reset, service recovers
      jest.useFakeTimers()
      jest.advanceTimersByTime(600)

      simulateStellarRpc.mockResolvedValue('tx_hash_abc')
      const hash = await stellarAdapter.execute(
        simulateStellarRpc,
        'stellar.submitTransaction'
      )
      expect(hash).toBe('tx_hash_abc')

      jest.useRealTimers()
    })
  })

  describe('Anthropic client scenario', () => {
    it('should retry Anthropic API failures and fall back gracefully', async () => {
      const anthropicAdapter = new HttpClientAdapter({
        timeoutMs: 100,
        maxRetries: 1,
        baseDelayMs: 10,
        maxDelayMs: 50,
        circuitBreakerThreshold: 5,
        circuitBreakerResetMs: 1000,
      })

      const simulateAnthropicApi = jest.fn()

      // Transient failure then success
      simulateAnthropicApi
        .mockRejectedValueOnce(new Error('anthropic: rate limited'))
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: '{"action":"balance"}' }],
        })

      const result = await anthropicAdapter.execute(
        simulateAnthropicApi,
        'anthropic.parseIntent'
      )
      expect(result).toEqual({
        content: [{ type: 'text', text: '{"action":"balance"}' }],
      })
      expect(simulateAnthropicApi).toHaveBeenCalledTimes(2)
    })
  })

  describe('Twilio client scenario', () => {
    it('should retry Twilio API failures', async () => {
      const twilioAdapter = new HttpClientAdapter({
        timeoutMs: 100,
        maxRetries: 1,
        baseDelayMs: 10,
        maxDelayMs: 50,
        circuitBreakerThreshold: 5,
        circuitBreakerResetMs: 1000,
      })

      const simulateTwilioApi = jest.fn()

      // Transient failure
      simulateTwilioApi
        .mockRejectedValueOnce(new Error('twilio: upstream timeout'))
        .mockResolvedValueOnce({ sid: 'SM12345' })

      const result = await twilioAdapter.execute(
        simulateTwilioApi,
        'twilio.sendWhatsAppMessage'
      )
      expect(result).toEqual({ sid: 'SM12345' })
      expect(simulateTwilioApi).toHaveBeenCalledTimes(2)
    })
  })
})
