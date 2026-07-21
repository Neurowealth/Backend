import {
  HttpClientAdapter,
  CircuitBreakerError,
  TimeoutError,
} from '../../../src/utils/http-client'

describe('HttpClientAdapter', () => {
  let adapter: HttpClientAdapter

  beforeEach(() => {
    adapter = new HttpClientAdapter({
      timeoutMs: 1000,
      maxRetries: 2,
      baseDelayMs: 10,
      maxDelayMs: 100,
      circuitBreakerThreshold: 3,
      circuitBreakerResetMs: 100,
    })
  })

  describe('execute', () => {
    it('should return the result of a successful function', async () => {
      const result = await adapter.execute(async () => 'ok')
      expect(result).toBe('ok')
    })

    it('should throw on a failing function', async () => {
      await expect(
        adapter.execute(async () => {
          throw new Error('fail')
        })
      ).rejects.toThrow('fail')
    })

    it('should retry on failure and succeed on retry', async () => {
      let attempts = 0
      const fn = jest.fn().mockImplementation(async () => {
        attempts++
        if (attempts < 2) throw new Error('transient failure')
        return 'recovered'
      })

      const result = await adapter.execute(fn)
      expect(result).toBe('recovered')
      expect(fn).toHaveBeenCalledTimes(2)
    })

    it('should respect maxRetries and throw after all retries exhausted', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('persistent failure'))

      await expect(adapter.execute(fn)).rejects.toThrow('persistent failure')
      expect(fn).toHaveBeenCalledTimes(3) // 1 initial + 2 retries
    })

    it('should not retry if the circuit breaker opens mid-retry', async () => {
      const lowThresholdAdapter = new HttpClientAdapter({
        timeoutMs: 1000,
        maxRetries: 5,
        baseDelayMs: 10,
        maxDelayMs: 100,
        circuitBreakerThreshold: 2,
        circuitBreakerResetMs: 50000,
      })

      const fn = jest.fn().mockRejectedValue(new Error('fail'))

      await expect(lowThresholdAdapter.execute(fn)).rejects.toThrow('fail')
      expect(fn).toHaveBeenCalledTimes(2) // 1 initial, 1 retry — then circuit opens
    })
  })

  describe('timeout', () => {
    it('should throw TimeoutError if function exceeds timeout', async () => {
      const slowAdapter = new HttpClientAdapter({
        timeoutMs: 50,
        maxRetries: 0,
        baseDelayMs: 10,
        maxDelayMs: 100,
        circuitBreakerThreshold: 10,
        circuitBreakerResetMs: 1000,
      })

      await expect(
        slowAdapter.execute(async () => {
          await new Promise((r) => setTimeout(r, 200))
          return 'too late'
        })
      ).rejects.toThrow(TimeoutError)
    })
  })

  describe('circuit breaker', () => {
    it('should block requests when circuit is open', async () => {
      // Trigger circuit breaker by exceeding threshold
      const fn = jest.fn().mockRejectedValue(new Error('fail'))

      for (let i = 0; i < 3; i++) {
        await expect(adapter.execute(fn)).rejects.toThrow()
      }

      // Next call should be blocked by circuit breaker
      await expect(adapter.execute(fn)).rejects.toThrow(CircuitBreakerError)
    })

    it('should transition to half-open after reset timeout', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('fail'))

      // Trigger circuit breaker (3 failures needed)
      for (let i = 0; i < 3; i++) {
        await expect(adapter.execute(fn)).rejects.toThrow()
      }

      // Circuit is OPEN - should block
      await expect(adapter.execute(fn)).rejects.toThrow(CircuitBreakerError)

      // Advance past reset timeout
      jest.useFakeTimers()
      jest.advanceTimersByTime(200)

      // Should now be half-open and allow one request
      // But it's still failing, so it should throw fail (not CircuitBreakerError)
      await expect(adapter.execute(fn)).rejects.toThrow('fail')

      jest.useRealTimers()
    })

    it('should reset state after successful request in half-open state', async () => {
      const fn = jest.fn()

      // Trip circuit breaker: 3 failures
      fn.mockRejectedValue(new Error('fail'))
      for (let i = 0; i < 3; i++) {
        await expect(adapter.execute(fn)).rejects.toThrow()
      }

      // Circuit is OPEN
      await expect(adapter.execute(fn)).rejects.toThrow(CircuitBreakerError)

      // Advance past reset timeout
      jest.useFakeTimers()
      jest.advanceTimersByTime(200)

      // Now half-open — succeed
      fn.mockResolvedValue('recovered')
      const result = await adapter.execute(fn)
      expect(result).toBe('recovered')

      // Circuit should now be CLOSED — next request goes through immediately
      const result2 = await adapter.execute(async () => 'all good')
      expect(result2).toBe('all good')

      jest.useRealTimers()
    })
  })

  describe('getState', () => {
    it('should return closed state and 0 failures initially', () => {
      const state = adapter.getState()
      expect(state.state).toBe('closed')
      expect(state.failures).toBe(0)
    })

    it('should track failure count', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('fail'))
      await expect(adapter.execute(fn)).rejects.toThrow()

      const state = adapter.getState()
      expect(state.failures).toBeGreaterThanOrEqual(1)
    })
  })

  describe('reset', () => {
    it('should reset state back to closed', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('fail'))

      for (let i = 0; i < 3; i++) {
        await expect(adapter.execute(fn)).rejects.toThrow()
      }

      expect(adapter.getState().state).toBe('open')

      adapter.reset()

      expect(adapter.getState().state).toBe('closed')
      expect(adapter.getState().failures).toBe(0)
    })
  })

  describe('context label', () => {
    it('should include context in TimeoutError message', async () => {
      const fastTimeoutAdapter = new HttpClientAdapter({
        timeoutMs: 10,
        maxRetries: 0,
        baseDelayMs: 10,
        maxDelayMs: 100,
        circuitBreakerThreshold: 10,
        circuitBreakerResetMs: 1000,
      })

      await expect(
        fastTimeoutAdapter.execute(async () => {
          await new Promise((r) => setTimeout(r, 100))
          return 'x'
        }, 'myService.myMethod')
      ).rejects.toThrow(/myService\.myMethod/)
    })

    it('should include context in CircuitBreakerError message', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('fail'))

      for (let i = 0; i < 3; i++) {
        await expect(adapter.execute(fn)).rejects.toThrow()
      }

      await expect(adapter.execute(fn, 'myService.myMethod')).rejects.toThrow(
        /myService\.myMethod/
      )
    })
  })
})
