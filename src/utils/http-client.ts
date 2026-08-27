import { logger } from './logger'

export interface HttpClientConfig {
  timeoutMs: number
  maxRetries: number
  baseDelayMs: number
  maxDelayMs: number
  circuitBreakerThreshold: number
  circuitBreakerResetMs: number
}

export type CircuitState = 'closed' | 'open' | 'half-open'

export const DEFAULT_HTTP_CLIENT_CONFIG: HttpClientConfig = {
  timeoutMs: 10_000,
  maxRetries: 3,
  baseDelayMs: 200,
  maxDelayMs: 10_000,
  circuitBreakerThreshold: 5,
  circuitBreakerResetMs: 30_000,
}

export class CircuitBreakerError extends Error {
  constructor(context?: string) {
    const msg = context
      ? `Circuit breaker is OPEN for "${context}". Request blocked.`
      : 'Circuit breaker is OPEN. Request blocked.'
    super(msg)
    this.name = 'CircuitBreakerError'
  }
}

export class TimeoutError extends Error {
  constructor(timeoutMs: number, context?: string) {
    const msg = context
      ? `Request "${context}" timed out after ${timeoutMs}ms`
      : `Request timed out after ${timeoutMs}ms`
    super(msg)
    this.name = 'TimeoutError'
  }
}

export class HttpClientAdapter {
  private config: HttpClientConfig
  private state: CircuitState = 'closed'
  private failures: number = 0
  private lastFailureTime: number = 0

  constructor(config: Partial<HttpClientConfig> = {}) {
    this.config = { ...DEFAULT_HTTP_CLIENT_CONFIG, ...config }
  }

  getConfig(): Readonly<HttpClientConfig> {
    return this.config
  }

  getState(): { state: CircuitState; failures: number } {
    return { state: this.state, failures: this.failures }
  }

  reset(): void {
    this.state = 'closed'
    this.failures = 0
    this.lastFailureTime = 0
  }

  async execute<T>(fn: () => Promise<T>, context?: string): Promise<T> {
    this.checkCircuitBreaker(context)

    let lastError: Error | undefined

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          logger.debug(
            `[HttpClientAdapter] Retry attempt ${attempt}/${this.config.maxRetries}${context ? ` for "${context}"` : ''}`
          )
        }
        const result = await this.executeWithTimeout(fn, context)
        this.onSuccess()
        return result
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        this.onFailure(lastError)

        if (this.state === 'open') {
          break
        }

        if (attempt < this.config.maxRetries) {
          await this.delay(attempt)
        }
      }
    }

    throw lastError!
  }

  private async executeWithTimeout<T>(
    fn: () => Promise<T>,
    context?: string
  ): Promise<T> {
    const { timeoutMs } = this.config

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new TimeoutError(timeoutMs, context))
      }, timeoutMs)

      fn()
        .then((result) => {
          clearTimeout(timer)
          resolve(result)
        })
        .catch((error) => {
          clearTimeout(timer)
          reject(error)
        })
    })
  }

  private checkCircuitBreaker(context?: string): void {
    if (this.state === 'open') {
      if (
        Date.now() - this.lastFailureTime >=
        this.config.circuitBreakerResetMs
      ) {
        this.state = 'half-open'
        logger.debug(
          '[HttpClientAdapter] Circuit breaker transitioning to half-open'
        )
      } else {
        throw new CircuitBreakerError(context)
      }
    }
  }

  private onSuccess(): void {
    if (this.state === 'half-open') {
      logger.debug(
        '[HttpClientAdapter] Circuit breaker closing after successful half-open request'
      )
    }
    this.state = 'closed'
    this.failures = Math.max(0, this.failures - 1)
  }

  private onFailure(error: Error): void {
    this.failures++
    this.lastFailureTime = Date.now()

    logger.debug(
      `[HttpClientAdapter] Failure #${this.failures}/${this.config.circuitBreakerThreshold}: ${error.message}`
    )

    if (this.failures >= this.config.circuitBreakerThreshold) {
      this.state = 'open'
      logger.warn(
        `[HttpClientAdapter] Circuit breaker OPEN after ${this.failures} failures`
      )
    }
  }

  private async delay(attempt: number): Promise<void> {
    const delayMs = Math.min(
      this.config.baseDelayMs * Math.pow(2, attempt),
      this.config.maxDelayMs
    )
    const jitter = delayMs * (0.5 + Math.random() * 0.5)
    return new Promise((resolve) => setTimeout(resolve, jitter))
  }
}
