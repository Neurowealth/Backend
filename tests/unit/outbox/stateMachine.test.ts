import {
  canTransition,
  assertTransition,
  compareForDispatch,
  sortForDispatch,
  computeBackoffMs,
  PRIORITY_WEIGHT,
} from '../../../src/outbox/stateMachine'
import { OutboxOpRecord } from '../../../src/outbox/types'

function op(
  overrides: Partial<Pick<OutboxOpRecord, 'priority' | 'createdAt' | 'id'>>
): Pick<OutboxOpRecord, 'priority' | 'createdAt'> & { id?: string } {
  return {
    priority: 'NORMAL',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  }
}

describe('src/outbox/stateMachine — transitions', () => {
  it('allows the documented PENDING -> SUBMITTED -> CONFIRMED happy path', () => {
    expect(canTransition('PENDING', 'SUBMITTED')).toBe(true)
    expect(canTransition('SUBMITTED', 'CONFIRMED')).toBe(true)
  })

  it('allows a transient submit failure to return SUBMITTED -> PENDING for retry', () => {
    expect(canTransition('SUBMITTED', 'PENDING')).toBe(true)
  })

  it('allows SUBMITTED -> FAILED (terminal or fee-bump-cap escalation)', () => {
    expect(canTransition('SUBMITTED', 'FAILED')).toBe(true)
  })

  it('allows PENDING -> CANCELLED (admin cancels an unsent op)', () => {
    expect(canTransition('PENDING', 'CANCELLED')).toBe(true)
  })

  it('allows FAILED -> PENDING only for admin force-retry', () => {
    expect(canTransition('FAILED', 'PENDING')).toBe(true)
  })

  it('CONFIRMED and CANCELLED are terminal — no transitions out', () => {
    expect(canTransition('CONFIRMED', 'PENDING')).toBe(false)
    expect(canTransition('CONFIRMED', 'FAILED')).toBe(false)
    expect(canTransition('CANCELLED', 'PENDING')).toBe(false)
  })

  it('rejects illegal jumps, e.g. PENDING -> CONFIRMED directly', () => {
    expect(canTransition('PENDING', 'CONFIRMED')).toBe(false)
  })

  it('assertTransition throws with a clear message on an illegal transition', () => {
    expect(() => assertTransition('CONFIRMED', 'PENDING')).toThrow(
      /Illegal outbox transition: CONFIRMED -> PENDING/
    )
  })

  it('assertTransition does not throw on a legal transition', () => {
    expect(() => assertTransition('PENDING', 'SUBMITTED')).not.toThrow()
  })
})

describe('src/outbox/stateMachine — priority ordering', () => {
  it('orders CRITICAL before NORMAL before LOW', () => {
    expect(PRIORITY_WEIGHT.CRITICAL).toBeLessThan(PRIORITY_WEIGHT.NORMAL)
    expect(PRIORITY_WEIGHT.NORMAL).toBeLessThan(PRIORITY_WEIGHT.LOW)
  })

  it('within the same priority, orders oldest createdAt first (FIFO)', () => {
    const older = op({
      priority: 'NORMAL',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    })
    const newer = op({
      priority: 'NORMAL',
      createdAt: new Date('2026-01-01T00:05:00Z'),
    })
    expect(compareForDispatch(older, newer)).toBeLessThan(0)
    expect(compareForDispatch(newer, older)).toBeGreaterThan(0)
  })

  it('does not starve a CRITICAL op behind a wave of NORMAL ops', () => {
    // Simulates the scenario called out in issue #325: a burst of NORMAL
    // recurring-deposit/referral ops queued well before a CRITICAL withdrawal
    // must still let the withdrawal dispatch first.
    const normalWave = Array.from({ length: 100 }, (_, i) =>
      op({
        id: `normal-${i}`,
        priority: 'NORMAL',
        createdAt: new Date(Date.now() - (100 - i) * 1000), // all older than the CRITICAL op
      })
    )
    const criticalWithdrawal = op({
      id: 'critical-1',
      priority: 'CRITICAL',
      createdAt: new Date(), // youngest of the batch
    })

    const sorted = sortForDispatch([...normalWave, criticalWithdrawal])
    expect(sorted[0]).toBe(criticalWithdrawal)
  })

  it('does not starve a CRITICAL op behind a wave of LOW-priority rebalances', () => {
    const lowWave = Array.from({ length: 50 }, (_, i) =>
      op({
        id: `low-${i}`,
        priority: 'LOW',
        createdAt: new Date(Date.now() - (50 - i) * 1000),
      })
    )
    const criticalWithdrawal = op({ id: 'critical-1', priority: 'CRITICAL' })

    const sorted = sortForDispatch([...lowWave, criticalWithdrawal])
    expect(sorted[0]).toBe(criticalWithdrawal)
  })

  it('sortForDispatch does not mutate the input array', () => {
    const a = op({ priority: 'LOW', createdAt: new Date(1000) })
    const b = op({ priority: 'CRITICAL', createdAt: new Date(2000) })
    const input = [a, b]
    const sorted = sortForDispatch(input)
    expect(input[0]).toBe(a) // original order preserved
    expect(sorted[0]).toBe(b)
  })

  it('a full priority mix sorts as CRITICAL, NORMAL, LOW', () => {
    const low = op({ id: 'low', priority: 'LOW' })
    const normal = op({ id: 'normal', priority: 'NORMAL' })
    const critical = op({ id: 'critical', priority: 'CRITICAL' })

    const sorted = sortForDispatch([low, normal, critical])
    expect(sorted.map((o) => o.priority)).toEqual(['CRITICAL', 'NORMAL', 'LOW'])
  })
})

describe('src/outbox/stateMachine — backoff', () => {
  it('is bounded by [0, min(base * 2^(attempt-1), max)]', () => {
    const random = () => 1 // force the upper bound
    expect(computeBackoffMs(1, 1000, 60000, random)).toBe(1000)
    expect(computeBackoffMs(2, 1000, 60000, random)).toBe(2000)
    expect(computeBackoffMs(3, 1000, 60000, random)).toBe(4000)
  })

  it('caps at maxMs regardless of how large attempt grows', () => {
    const random = () => 1
    expect(computeBackoffMs(20, 1000, 60000, random)).toBe(60000)
  })

  it('at random()=0, backoff is always 0 (full jitter floor)', () => {
    const random = () => 0
    expect(computeBackoffMs(5, 1000, 60000, random)).toBe(0)
  })

  it('never exceeds maxMs across many random samples', () => {
    for (let i = 0; i < 200; i++) {
      const ms = computeBackoffMs(10, 2000, 30000, Math.random)
      expect(ms).toBeGreaterThanOrEqual(0)
      expect(ms).toBeLessThanOrEqual(30000)
    }
  })
})
