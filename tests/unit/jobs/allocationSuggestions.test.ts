/**
 * Allocation-suggestion job unit tests (#322).
 *
 * The two properties that matter for a background job of this shape:
 *   1. It runs inside a correlation-ID scope, so its logs are traceable.
 *   2. ONE user's failure does not abort the batch. Without that, a single
 *      corrupt strategyConfig silently deprives every user after it in the list
 *      of a refreshed suggestion — and nothing would look broken.
 */

jest.mock('../../../src/db', () => ({ __esModule: true, default: {} }))
jest.mock('../../../src/analytics/service', () => ({
  suggestAllocation: jest.fn(),
}))
jest.mock('../../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  logBackgroundJob: jest.fn(),
}))
jest.mock('../../../src/utils/metrics', () => ({
  recordBackgroundJob: jest.fn(),
}))
jest.mock('../../../src/utils/job-metrics', () => ({
  recordJobSuccess: jest.fn(),
  recordJobFailure: jest.fn(),
}))

import db from '../../../src/db'
import { logBackgroundJob } from '../../../src/utils/logger'
import {
  recordJobSuccess,
  recordJobFailure,
} from '../../../src/utils/job-metrics'
import { suggestAllocation } from '../../../src/analytics/service'
import { getCorrelationId } from '../../../src/utils/correlation'
import { computeAllocationSuggestions } from '../../../src/jobs/allocationSuggestions'

const mockDb = db as any
const mockSuggest = suggestAllocation as jest.Mock
const NOW = new Date('2026-08-17T00:00:00Z')

beforeEach(() => {
  mockDb.position = { findMany: jest.fn().mockResolvedValue([]) }
  mockSuggest.mockReset()
  mockSuggest.mockResolvedValue({ status: 'ok' })
})

describe('computeAllocationSuggestions', () => {
  it('only considers users with an ACTIVE position', async () => {
    await computeAllocationSuggestions(NOW)

    const where = mockDb.position.findMany.mock.calls[0][0]
    expect(where.where).toEqual({ status: 'ACTIVE' })
    expect(where.distinct).toEqual(['userId'])
  })

  it('computes a suggestion for each invested user', async () => {
    mockDb.position.findMany.mockResolvedValue([
      { userId: 'u1' },
      { userId: 'u2' },
      { userId: 'u3' },
    ])

    await computeAllocationSuggestions(NOW)

    expect(mockSuggest).toHaveBeenCalledTimes(3)
    expect(mockSuggest.mock.calls.map((c) => c[0])).toEqual(['u1', 'u2', 'u3'])
  })

  it('persists but skips the expensive backtest legs', async () => {
    mockDb.position.findMany.mockResolvedValue([{ userId: 'u1' }])

    await computeAllocationSuggestions(NOW)

    expect(mockSuggest).toHaveBeenCalledWith('u1', {
      now: NOW,
      persist: true,
      runBacktest: false,
    })
  })

  it('runs inside a correlation-ID scope', async () => {
    mockDb.position.findMany.mockResolvedValue([{ userId: 'u1' }])
    let seen: string | undefined
    mockSuggest.mockImplementation(async () => {
      seen = getCorrelationId()
      return { status: 'ok' }
    })

    await computeAllocationSuggestions(NOW)

    expect(seen).toBeDefined()
    expect(typeof seen).toBe('string')
  })

  it('one user failure does not abort the batch', async () => {
    mockDb.position.findMany.mockResolvedValue([
      { userId: 'u1' },
      { userId: 'boom' },
      { userId: 'u3' },
    ])
    mockSuggest.mockImplementation(async (userId: string) => {
      if (userId === 'boom') throw new Error('corrupt strategyConfig')
      return { status: 'ok' }
    })

    await computeAllocationSuggestions(NOW)

    // u3 must still have been attempted after boom threw.
    expect(mockSuggest.mock.calls.map((c) => c[0])).toEqual([
      'u1',
      'boom',
      'u3',
    ])

    const [name, status, , , details] = (logBackgroundJob as jest.Mock).mock
      .calls[0]
    expect(name).toBe('allocation_suggestions')
    expect(status).toBe('success')
    expect(details).toMatchObject({ computed: 2, failed: 1 })
  })

  it('records job success with the standard metrics quartet', async () => {
    mockDb.position.findMany.mockResolvedValue([{ userId: 'u1' }])

    await computeAllocationSuggestions(NOW)

    expect(recordJobSuccess).toHaveBeenCalledWith(
      'allocation_suggestions',
      expect.any(Number)
    )
    expect(recordJobFailure).not.toHaveBeenCalled()
  })

  it('never rethrows — a job-level failure is logged as failed', async () => {
    mockDb.position.findMany.mockRejectedValue(new Error('db is down'))

    await expect(computeAllocationSuggestions(NOW)).resolves.toBeUndefined()

    expect(recordJobFailure).toHaveBeenCalledWith(
      'allocation_suggestions',
      expect.any(Number)
    )
    const [name, status] = (logBackgroundJob as jest.Mock).mock.calls[0]
    expect(name).toBe('allocation_suggestions')
    expect(status).toBe('failed')
  })

  it('handles an empty user set without error', async () => {
    await expect(computeAllocationSuggestions(NOW)).resolves.toBeUndefined()
    expect(mockSuggest).not.toHaveBeenCalled()
  })
})
