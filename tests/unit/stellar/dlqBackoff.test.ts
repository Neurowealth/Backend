/**
 * #610 — DLQ backoff schedule, poison-message cap, and admin actions.
 *
 * These tests pin the retry policy: entries inside their backoff window are
 * skipped (not retried), entries past MAX_RETRY_ATTEMPTS transition to the
 * terminal POISON state, and the admin discard/requeue actions mutate the
 * row as the runbook promises.
 */

import db from '../../../src/db'
import {
  DeadLetterQueue,
  MAX_RETRY_ATTEMPTS,
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  computeBackoffMs,
} from '../../../src/stellar/dlq'

jest.mock('../../../src/db', () => ({ __esModule: true, default: {} }))
jest.mock('../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))
jest.mock('../../../src/utils/metrics', () => ({
  updateDlqSize: jest.fn(),
  dlqAlertActive: { set: jest.fn() },
  dlqPoisonSize: { set: jest.fn() },
}))
jest.mock('../../../src/services/alerting', () => ({
  alertingService: {
    emitDLQAlert: jest.fn(),
    clearDLQAlertState: jest.fn(),
  },
}))
jest.mock('../../../src/utils/correlation', () => ({
  getCorrelationId: jest.fn(() => undefined),
}))

const mockDb = db as any

function row(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: 'dle-x',
    contractId: 'CVAULT',
    txHash: 'tx-x',
    eventType: 'deposit',
    ledger: 100,
    error: 'ledger replay conflict',
    payload: {},
    status: 'PENDING',
    retryCount: 0,
    createdAt: new Date('2026-10-21T00:00:00Z'),
    updatedAt: new Date('2026-10-21T00:00:00Z'),
    ...overrides,
  }
}

describe('computeBackoffMs (#610)', () => {
  it('doubles each attempt until it hits the cap', () => {
    const rng = () => 0.5 // central value → jitter factor exactly 1.0
    expect(computeBackoffMs(0, rng)).toBe(BACKOFF_BASE_MS)
    expect(computeBackoffMs(1, rng)).toBe(BACKOFF_BASE_MS * 2)
    expect(computeBackoffMs(2, rng)).toBe(BACKOFF_BASE_MS * 4)
    expect(computeBackoffMs(10, rng)).toBe(BACKOFF_MAX_MS)
    expect(computeBackoffMs(20, rng)).toBe(BACKOFF_MAX_MS)
  })

  it('applies ±50% jitter', () => {
    const low = computeBackoffMs(2, () => 0) // factor 0.5
    const mid = computeBackoffMs(2, () => 0.5) // factor 1.0
    const high = computeBackoffMs(2, () => 1) // factor 1.5
    expect(low).toBeLessThan(mid)
    expect(mid).toBeLessThan(high)
    expect(low).toBe(Math.round(BACKOFF_BASE_MS * 4 * 0.5))
    expect(high).toBe(Math.round(BACKOFF_BASE_MS * 4 * 1.5))
  })
})

describe('DeadLetterQueue.retryAll backoff gate (#610)', () => {
  const BASE_TIME = new Date('2026-10-21T00:00:00Z')

  beforeEach(() => {
    mockDb.deadLetterEvent = {
      findMany: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(0),
    }
  })

  it('skips an entry whose backoff window has not elapsed', async () => {
    const retryCount = 2
    const lastAttempt = BASE_TIME
    const earlyNow = new Date(
      lastAttempt.getTime() + computeBackoffMs(retryCount, () => 0.5) - 1_000
    )
    mockDb.deadLetterEvent.findMany.mockResolvedValue([
      row({
        id: 'skip-me',
        status: 'RETRIED',
        retryCount,
        updatedAt: lastAttempt,
      }),
    ])
    const retryFn = jest.fn()
    const result = await DeadLetterQueue.retryAll(retryFn, {
      now: () => earlyNow,
      rng: () => 0.5,
    })
    expect(retryFn).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      resolved: 0,
      failed: 0,
      skipped: 1,
      poisoned: 0,
    })
    expect(mockDb.deadLetterEvent.update).not.toHaveBeenCalled()
  })

  it('retries an entry whose backoff window has elapsed', async () => {
    const retryCount = 2
    const lastAttempt = BASE_TIME
    const dueNow = new Date(
      lastAttempt.getTime() + computeBackoffMs(retryCount, () => 0.5) + 1_000
    )
    mockDb.deadLetterEvent.findMany.mockResolvedValue([
      row({
        id: 'retry-me',
        status: 'RETRIED',
        retryCount,
        updatedAt: lastAttempt,
      }),
    ])
    const retryFn = jest.fn().mockResolvedValue(undefined)
    const result = await DeadLetterQueue.retryAll(retryFn, {
      now: () => dueNow,
      rng: () => 0.5,
    })
    expect(retryFn).toHaveBeenCalledTimes(1)
    expect(result.resolved).toBe(1)
  })

  it('retries first-attempt entries immediately (no backoff on retryCount=0)', async () => {
    mockDb.deadLetterEvent.findMany.mockResolvedValue([row({ retryCount: 0 })])
    const retryFn = jest.fn().mockResolvedValue(undefined)
    const result = await DeadLetterQueue.retryAll(retryFn)
    expect(retryFn).toHaveBeenCalledTimes(1)
    expect(result.resolved).toBe(1)
  })
})

describe('DeadLetterQueue POISON transition (#610)', () => {
  beforeEach(() => {
    mockDb.deadLetterEvent = {
      findMany: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(0),
    }
  })

  it('transitions to POISON on the attempt that pushes retryCount to MAX', async () => {
    const almostPoisoned = row({
      id: 'about-to-die',
      status: 'RETRIED',
      retryCount: MAX_RETRY_ATTEMPTS - 1,
      updatedAt: new Date('1970-01-01'), // ancient — backoff elapsed
    })
    mockDb.deadLetterEvent.findMany.mockResolvedValue([almostPoisoned])
    const retryFn = jest.fn().mockRejectedValue(new Error('upstream still bad'))

    const result = await DeadLetterQueue.retryAll(retryFn)

    expect(retryFn).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ resolved: 0, failed: 0, poisoned: 1 })
    expect(mockDb.deadLetterEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'about-to-die' },
        data: expect.objectContaining({
          status: 'POISON',
          retryCount: MAX_RETRY_ATTEMPTS,
        }),
      })
    )
  })

  it('does not pick up POISON entries at all (never auto-retries)', async () => {
    // The findMany contract filters status IN ('PENDING','RETRIED'), so
    // POISON rows simply do not appear. Mirror that filter in the mock to
    // assert the production WHERE clause does not change.
    mockDb.deadLetterEvent.findMany.mockImplementation(
      ({ where }: { where: any }) => {
        const permitted: string[] = where?.status?.in ?? []
        expect(permitted).not.toContain('POISON')
        return []
      }
    )
    const retryFn = jest.fn()
    await DeadLetterQueue.retryAll(retryFn)
    expect(retryFn).not.toHaveBeenCalled()
  })
})

describe('DeadLetterQueue admin actions (#610)', () => {
  beforeEach(() => {
    mockDb.deadLetterEvent = {
      delete: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(0),
    }
  })

  it('discard removes the row entirely', async () => {
    const ok = await DeadLetterQueue.discard('dle-discard')
    expect(ok).toBe(true)
    expect(mockDb.deadLetterEvent.delete).toHaveBeenCalledWith({
      where: { id: 'dle-discard' },
    })
  })

  it('discard returns false when the row is missing', async () => {
    mockDb.deadLetterEvent.delete.mockRejectedValueOnce(new Error('not found'))
    const ok = await DeadLetterQueue.discard('missing')
    expect(ok).toBe(false)
  })

  it('requeue resets status to PENDING and retryCount to 0', async () => {
    const ok = await DeadLetterQueue.requeue('dle-poison')
    expect(ok).toBe(true)
    expect(mockDb.deadLetterEvent.update).toHaveBeenCalledWith({
      where: { id: 'dle-poison' },
      data: { status: 'PENDING', retryCount: 0 },
    })
  })

  it('getPoisonCount queries only POISON rows', async () => {
    mockDb.deadLetterEvent.count.mockResolvedValue(3)
    const n = await DeadLetterQueue.getPoisonCount()
    expect(n).toBe(3)
    expect(mockDb.deadLetterEvent.count).toHaveBeenCalledWith({
      where: { status: 'POISON' },
    })
  })
})
