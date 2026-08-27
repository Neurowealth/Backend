/**
 * In-flight concurrency limiter unit tests (#322).
 *
 * The failure mode this guards against is a LEAKED SLOT: if a release is missed
 * or double-counted, a user is permanently locked out of the optimizer for the
 * process lifetime, and no error is logged anywhere. Several tests below exist
 * purely to pin that down.
 */

import {
  ConcurrencyLimiter,
  isAcquireFailure,
} from '../../../src/utils/concurrency'

describe('ConcurrencyLimiter', () => {
  it('grants a slot when nothing is in flight', () => {
    const limiter = new ConcurrencyLimiter({ globalLimit: 2, perKeyLimit: 1 })
    const slot = limiter.tryAcquire('u1')
    expect(isAcquireFailure(slot)).toBe(false)
    expect(limiter.inFlight).toBe(1)
  })

  it('refuses a second slot for the same key and blames the key', () => {
    const limiter = new ConcurrencyLimiter({ globalLimit: 5, perKeyLimit: 1 })
    limiter.tryAcquire('u1')
    const second = limiter.tryAcquire('u1')

    expect(isAcquireFailure(second)).toBe(true)
    if (!isAcquireFailure(second)) return
    expect(second.scope).toBe('key')
  })

  it('lets a different key through while one key is saturated', () => {
    const limiter = new ConcurrencyLimiter({ globalLimit: 5, perKeyLimit: 1 })
    limiter.tryAcquire('u1')
    expect(isAcquireFailure(limiter.tryAcquire('u2'))).toBe(false)
  })

  it('refuses once the global budget is exhausted and blames global', () => {
    const limiter = new ConcurrencyLimiter({ globalLimit: 2, perKeyLimit: 1 })
    limiter.tryAcquire('u1')
    limiter.tryAcquire('u2')
    const third = limiter.tryAcquire('u3')

    expect(isAcquireFailure(third)).toBe(true)
    if (!isAcquireFailure(third)) return
    expect(third.scope).toBe('global')
  })

  it('reports the per-key bound first, since the two mean different things', () => {
    // A user hammering the endpoint must not be reported as global saturation.
    const limiter = new ConcurrencyLimiter({ globalLimit: 1, perKeyLimit: 1 })
    limiter.tryAcquire('u1')
    const again = limiter.tryAcquire('u1')

    expect(isAcquireFailure(again)).toBe(true)
    if (!isAcquireFailure(again)) return
    expect(again.scope).toBe('key')
  })

  it('frees the slot on release', () => {
    const limiter = new ConcurrencyLimiter({ globalLimit: 1, perKeyLimit: 1 })
    const slot = limiter.tryAcquire('u1')
    if (isAcquireFailure(slot)) throw new Error('expected a slot')

    slot.release()

    expect(limiter.inFlight).toBe(0)
    expect(isAcquireFailure(limiter.tryAcquire('u1'))).toBe(false)
  })

  it('release is idempotent — a double free cannot inflate the budget', () => {
    const limiter = new ConcurrencyLimiter({ globalLimit: 2, perKeyLimit: 1 })
    const a = limiter.tryAcquire('u1')
    const b = limiter.tryAcquire('u2')
    if (isAcquireFailure(a) || isAcquireFailure(b)) throw new Error('slots')

    a.release()
    a.release()
    a.release()

    expect(limiter.inFlight).toBe(1)
    b.release()
    expect(limiter.inFlight).toBe(0)
  })

  it('does not leak per-key entries after release', () => {
    // The map is keyed by userId; leaving 0-count entries behind would grow it
    // without bound for the process lifetime.
    const limiter = new ConcurrencyLimiter({ globalLimit: 10, perKeyLimit: 1 })
    for (let i = 0; i < 100; i++) {
      const slot = limiter.tryAcquire(`user-${String(i)}`)
      if (isAcquireFailure(slot)) throw new Error('expected a slot')
      slot.release()
    }
    expect(limiter.activeKeys).toBe(0)
    expect(limiter.inFlight).toBe(0)
  })

  it('supports a per-key limit above 1', () => {
    const limiter = new ConcurrencyLimiter({ globalLimit: 10, perKeyLimit: 3 })
    expect(isAcquireFailure(limiter.tryAcquire('u1'))).toBe(false)
    expect(isAcquireFailure(limiter.tryAcquire('u1'))).toBe(false)
    expect(isAcquireFailure(limiter.tryAcquire('u1'))).toBe(false)
    expect(isAcquireFailure(limiter.tryAcquire('u1'))).toBe(true)
  })

  it('floors nonsensical limits at 1 rather than deadlocking', () => {
    // A misconfigured env var of 0 would otherwise reject every request forever.
    const limiter = new ConcurrencyLimiter({ globalLimit: 0, perKeyLimit: 0 })
    expect(isAcquireFailure(limiter.tryAcquire('u1'))).toBe(false)
  })

  it('recovers full capacity after a full acquire/release cycle', () => {
    const limiter = new ConcurrencyLimiter({ globalLimit: 2, perKeyLimit: 1 })
    const a = limiter.tryAcquire('u1')
    const b = limiter.tryAcquire('u2')
    if (isAcquireFailure(a) || isAcquireFailure(b)) throw new Error('slots')
    expect(isAcquireFailure(limiter.tryAcquire('u3'))).toBe(true)

    a.release()
    b.release()

    expect(isAcquireFailure(limiter.tryAcquire('u3'))).toBe(false)
    expect(isAcquireFailure(limiter.tryAcquire('u4'))).toBe(false)
  })
})
