/**
 * In-flight concurrency limiting for CPU-bound endpoints (#322).
 *
 * WHY THIS EXISTS SEPARATELY FROM THE RATE LIMITER. A rate limiter bounds
 * requests per WINDOW; it does nothing about how many are running AT ONCE. The
 * portfolio optimizer is the first genuinely CPU-bound thing in this API — a
 * projected-gradient solve swept across a 12-point efficient frontier, all on
 * the single Node event-loop thread. Ten concurrent optimizations do not merely
 * run slower; they block every other request in the process, including
 * /health/ready, for as long as they take. That turns one user's burst into an
 * availability incident.
 *
 * So the limits are deliberately two-layered:
 *   - per-key (per-user): 1. A user gets one optimization at a time. Nothing is
 *     gained by letting them queue their own work, and it is the cheapest way to
 *     make double-submit harmless.
 *   - global: a small worker budget. Bounds the damage from many users at once,
 *     independently of any single user's behaviour.
 *
 * NON-BLOCKING BY DESIGN. `tryAcquire` returns null immediately rather than
 * queueing. Queueing would convert a CPU problem into a latency-and-memory
 * problem and hold sockets open behind work the client has probably abandoned;
 * a fast 429 with Retry-After lets the caller decide.
 *
 * In-process only, like the express-rate-limit default store. Across multiple
 * instances each process gets its own budget — appropriate here, because the
 * resource being protected (this process's event loop) is itself per-process.
 */

/** Releases a held slot. Idempotent — calling twice does not double-free. */
export type ReleaseFn = () => void

export interface ConcurrencyLimiterOptions {
  /** Maximum simultaneous holders across all keys. */
  globalLimit: number
  /** Maximum simultaneous holders for any single key. */
  perKeyLimit: number
}

export interface AcquireFailure {
  /** Which bound rejected the attempt, for logging and metrics. */
  scope: 'global' | 'key'
}

export class ConcurrencyLimiter {
  private readonly globalLimit: number
  private readonly perKeyLimit: number
  private active = 0
  private readonly perKey = new Map<string, number>()

  constructor(options: ConcurrencyLimiterOptions) {
    this.globalLimit = Math.max(1, options.globalLimit)
    this.perKeyLimit = Math.max(1, options.perKeyLimit)
  }

  /**
   * Take a slot, or return the reason none was available.
   *
   * The per-key bound is checked FIRST so a single user hammering the endpoint
   * is reported as their own limit rather than as global saturation — the two
   * mean very different things to whoever reads the logs.
   */
  tryAcquire(key: string): { release: ReleaseFn } | AcquireFailure {
    const keyActive = this.perKey.get(key) ?? 0
    if (keyActive >= this.perKeyLimit) return { scope: 'key' }
    if (this.active >= this.globalLimit) return { scope: 'global' }

    this.active++
    this.perKey.set(key, keyActive + 1)

    let released = false
    const release: ReleaseFn = () => {
      if (released) return
      released = true
      this.active--
      const n = (this.perKey.get(key) ?? 1) - 1
      // Delete at zero rather than leaving a 0 entry: this map is keyed by
      // userId and would otherwise grow without bound for the process lifetime.
      if (n <= 0) this.perKey.delete(key)
      else this.perKey.set(key, n)
    }

    return { release }
  }

  /** Current global in-flight count. Exposed for metrics and tests. */
  get inFlight(): number {
    return this.active
  }

  /** Number of distinct keys holding a slot. Exposed for tests. */
  get activeKeys(): number {
    return this.perKey.size
  }
}

/** True when `tryAcquire` returned a failure rather than a slot. */
export function isAcquireFailure(
  result: { release: ReleaseFn } | AcquireFailure
): result is AcquireFailure {
  return (result as AcquireFailure).scope !== undefined
}
