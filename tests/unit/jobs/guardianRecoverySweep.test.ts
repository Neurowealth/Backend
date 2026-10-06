/**
 * Guardian recovery sweep tests (#535).
 *
 * The sweep is the only thing in the codebase that can execute a recovery, so
 * its failure modes are the ones that matter most:
 *
 *   1. It must NEVER execute a request whose delay has not elapsed. The query
 *      filter and `executeRecovery`'s own re-check are two independent guards;
 *      a regression in either must fail here.
 *   2. One bad request must not strand the rest of the batch.
 *   3. Expiry housekeeping must run on every tick, otherwise abandoned requests
 *      accumulate forever.
 */

process.env.NODE_ENV = 'test'

jest.mock('../../../src/db', () => {
  const findMany = jest.fn()
  const client: any = { recoveryRequest: { findMany } }
  return {
    __esModule: true,
    default: client,
    db: client,
    __mockFindMany: findMany,
  }
})

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

jest.mock('../../../src/guardians/service', () => ({
  OPEN_REQUEST_STATUSES: ['PENDING', 'QUORUM_REACHED'],
  executeRecovery: jest.fn(),
  expireStaleRequests: jest.fn().mockResolvedValue(0),
}))

jest.mock('../../../src/jobs/resilientScheduler', () => ({
  scheduleResilientJob: jest.fn().mockReturnValue({ unref: jest.fn() }),
}))

import { sweepGuardianRecovery } from '../../../src/jobs/guardianRecoverySweep'

const mockFindMany = require('../../../src/db').__mockFindMany
const {
  executeRecovery,
  expireStaleRequests,
} = require('../../../src/guardians/service')

function executedOutcome(id: string) {
  return {
    id,
    userId: 'user-1',
    status: 'COMPLETED',
    revokedSessions: 2,
    executedAt: new Date().toISOString(),
    executeAfter: null,
    executed: true,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  expireStaleRequests.mockResolvedValue(0)
  executeRecovery.mockImplementation((id: string) =>
    Promise.resolve(executedOutcome(id))
  )
})

describe('sweepGuardianRecovery', () => {
  it('selects only requests whose deadline has already passed', async () => {
    mockFindMany.mockResolvedValue([])

    await sweepGuardianRecovery()

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'QUORUM_REACHED',
          executeAfter: { lte: expect.any(Date) },
        }),
      })
    )
  })

  it('executes each due request and passes through the time it decided on', async () => {
    mockFindMany.mockResolvedValue([{ id: 'r1', userId: 'user-1' }])

    await sweepGuardianRecovery()

    expect(executeRecovery).toHaveBeenCalledWith('r1', expect.any(Date))
  })

  it('expires stale requests on every tick', async () => {
    mockFindMany.mockResolvedValue([])

    await sweepGuardianRecovery()

    expect(expireStaleRequests).toHaveBeenCalledWith(expect.any(Date))
  })

  it('uses ONE timestamp for the whole tick', async () => {
    // A fresh Date() per row would let a long sweep execute a request whose
    // deadline had not actually passed when the pass began.
    mockFindMany.mockResolvedValue([
      { id: 'r1', userId: 'user-1' },
      { id: 'r2', userId: 'user-1' },
    ])

    await sweepGuardianRecovery()

    const first = executeRecovery.mock.calls[0][1].getTime()
    const second = executeRecovery.mock.calls[1][1].getTime()
    expect(first).toBe(second)
  })

  it('does not let one failing request strand the rest of the batch', async () => {
    mockFindMany.mockResolvedValue([
      { id: 'r1', userId: 'user-1' },
      { id: 'r2', userId: 'user-1' },
      { id: 'r3', userId: 'user-1' },
    ])
    executeRecovery
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(executedOutcome('r2'))

    await expect(sweepGuardianRecovery()).resolves.toBeUndefined()

    // r1 failed, but r2 and r3 were still attempted.
    expect(executeRecovery).toHaveBeenCalledTimes(3)
  })

  it('treats a lost conditional update as a skip, not a failure', async () => {
    mockFindMany.mockResolvedValue([{ id: 'r1', userId: 'user-1' }])
    executeRecovery.mockResolvedValue({
      ...executedOutcome('r1'),
      executed: false,
    })

    await expect(sweepGuardianRecovery()).resolves.toBeUndefined()
    expect(executeRecovery).toHaveBeenCalledTimes(1)
  })

  it('never throws, even when the query itself fails', async () => {
    mockFindMany.mockRejectedValue(new Error('db down'))

    await expect(sweepGuardianRecovery()).resolves.toBeUndefined()
  })
})
