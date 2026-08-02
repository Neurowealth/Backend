/**
 * Fetch with timeout, retry, and circuit breaker support
 */

interface FetchOptions {
  timeout?: number
  retries?: number
  retryDelay?: number
}

interface CircuitBreaker {
  failures: number
  lastFailure: number
  isOpen: boolean
}

const circuitBreakers: Record<string, CircuitBreaker> = {}
const CIRCUIT_OPEN_DURATION = 60000 // 1 minute
const FAILURE_THRESHOLD = 3

export async function fetchWithRetry(
  url: string,
  options: FetchOptions = {}
): Promise<any> {
  const { timeout = 5000, retries = 3, retryDelay = 1000 } = options

  // Check circuit breaker
  const breaker = circuitBreakers[url] || {
    failures: 0,
    lastFailure: 0,
    isOpen: false,
  }
  if (breaker.isOpen) {
    const timeSinceFailure = Date.now() - breaker.lastFailure
    if (timeSinceFailure < CIRCUIT_OPEN_DURATION) {
      throw new Error(`Circuit breaker open for ${url}`)
    }
    breaker.isOpen = false
    breaker.failures = 0
  }

  let lastError: Error = new Error('Unknown error')

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeout)

      const res = await fetch(url, { signal: controller.signal })
      clearTimeout(timer)

      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`)

      // Reset circuit breaker on success
      circuitBreakers[url] = { failures: 0, lastFailure: 0, isOpen: false }

      return await res.json()
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      if (attempt < retries - 1) {
        await new Promise((r) => setTimeout(r, retryDelay * (attempt + 1)))
      }
    }
  }

  // Trip circuit breaker
  breaker.failures += 1
  breaker.lastFailure = Date.now()
  if (breaker.failures >= FAILURE_THRESHOLD) breaker.isOpen = true
  circuitBreakers[url] = breaker

  throw lastError
}
