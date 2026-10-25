import { correlationHeaders } from './correlation'

/**
 * Fetch with timeout, retry, and circuit breaker support
 */

interface FetchOptions {
  timeout?: number
  retries?: number
  retryDelay?: number
  maxResponseBytes?: number
}

interface CircuitBreaker {
  failures: number
  lastFailure: number
  isOpen: boolean
}

const circuitBreakers: Record<string, CircuitBreaker> = {}
const CIRCUIT_OPEN_DURATION = 60000 // 1 minute
const FAILURE_THRESHOLD = 3

async function readJsonResponse(
  response: Response,
  maxResponseBytes?: number
): Promise<any> {
  if (maxResponseBytes === undefined) return response.json()

  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
    throw new Error(`Response body exceeds ${maxResponseBytes} byte limit`)
  }

  if (!response.body) return response.json()

  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let totalBytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    totalBytes += value.byteLength
    if (totalBytes > maxResponseBytes) {
      await reader.cancel()
      throw new Error(`Response body exceeds ${maxResponseBytes} byte limit`)
    }
    chunks.push(Buffer.from(value))
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export async function fetchWithRetry(
  url: string,
  options: FetchOptions = {}
): Promise<any> {
  const {
    timeout = 5000,
    retries = 3,
    retryDelay = 1000,
    maxResponseBytes,
  } = options

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
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: correlationHeaders(),
      })

      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`)

      const payload = await readJsonResponse(res, maxResponseBytes)

      // Reset circuit breaker on success
      circuitBreakers[url] = { failures: 0, lastFailure: 0, isOpen: false }

      return payload
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      if (attempt < retries - 1) {
        await new Promise((r) => setTimeout(r, retryDelay * (attempt + 1)))
      }
    } finally {
      clearTimeout(timer)
    }
  }

  // Trip circuit breaker
  breaker.failures += 1
  breaker.lastFailure = Date.now()
  if (breaker.failures >= FAILURE_THRESHOLD) breaker.isOpen = true
  circuitBreakers[url] = breaker

  throw lastError
}
