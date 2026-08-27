/**
 * Per-signer serialization + in-flight concurrency caps for the dispatcher (#325).
 *
 * The agent-signed wallet (and any custodial user wallet) submits Stellar
 * transactions using that account's sequence number: two ops signed by the
 * same key must never be in flight at once, or the second submission's
 * sequence number will already be stale. This is an in-process mutex —
 * sufficient because a single dispatcher process claims ops (the atomic
 * PENDING -> SUBMITTED conditional update in src/outbox/service.ts is what
 * makes claiming itself safe across multiple dispatcher processes; running
 * more than one dispatcher process is out of scope for this change, and is
 * called out in docs/OUTBOX.md).
 */

class SignerLock {
  private queues = new Map<string, Promise<void>>()
  private globalInFlight = 0
  private perAccountInFlight = new Map<string, number>()

  constructor(
    private readonly globalMaxInFlight: number,
    private readonly perAccountMaxInFlight: number
  ) {}

  /** True if claiming one more op for this signer would exceed either cap. */
  hasCapacity(signerPublicKey: string): boolean {
    if (this.globalInFlight >= this.globalMaxInFlight) return false
    const accountInFlight = this.perAccountInFlight.get(signerPublicKey) ?? 0
    return accountInFlight < this.perAccountMaxInFlight
  }

  /**
   * Run `fn` holding the mutex for `signerPublicKey`. Ops for the same signer
   * queue and run strictly one-at-a-time, in call order; ops for different
   * signers run concurrently (subject to the global cap).
   */
  async withLock<T>(signerPublicKey: string, fn: () => Promise<T>): Promise<T> {
    const previousTail = this.queues.get(signerPublicKey) ?? Promise.resolve()

    let releaseNext: () => void
    const myTail = new Promise<void>((resolve) => {
      releaseNext = resolve
    })
    // Every future caller for this signer waits on `previousTail` (our turn)
    // followed by `myTail` (our own completion) before they get to run.
    this.queues.set(
      signerPublicKey,
      previousTail.then(() => myTail)
    )

    await previousTail

    this.globalInFlight++
    this.perAccountInFlight.set(
      signerPublicKey,
      (this.perAccountInFlight.get(signerPublicKey) ?? 0) + 1
    )

    try {
      return await fn()
    } finally {
      this.globalInFlight--
      const remaining = (this.perAccountInFlight.get(signerPublicKey) ?? 1) - 1
      if (remaining <= 0) {
        this.perAccountInFlight.delete(signerPublicKey)
      } else {
        this.perAccountInFlight.set(signerPublicKey, remaining)
      }
      releaseNext!()
    }
  }
}

let instance: SignerLock | null = null

export function getSignerLock(
  globalMaxInFlight: number,
  perAccountMaxInFlight: number
): SignerLock {
  if (!instance) {
    instance = new SignerLock(globalMaxInFlight, perAccountMaxInFlight)
  }
  return instance
}

export { SignerLock }
