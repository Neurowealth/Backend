/**
 * Session cleanup job unit tests (#472).
 *
 * The bug this pins: cleanup used to delete any session whose *access* token
 * had expired. Access tokens last 15 minutes and refresh tokens 7 days, so the
 * job deleted live, refreshable sessions every day and logged users out
 * mid-session. Deletion must require both halves to be dead.
 */

const mockSessionDeleteMany = jest.fn()

jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: {
    session: {
      deleteMany: (...args: unknown[]) => mockSessionDeleteMany(...args),
    },
  },
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

jest.mock('../../../src/utils/job-metrics', () => ({
  recordJobSuccess: jest.fn(),
  recordJobFailure: jest.fn(),
}))

jest.mock('../../../src/jobs/resilientScheduler', () => ({
  scheduleResilientJob: jest.fn(() => ({ unref: jest.fn() })),
}))

import { cleanupExpiredSessions } from '../../../src/jobs/sessionCleanup'

/** The where-clause passed to the first deleteMany (the live-session purge). */
function liveSessionFilter(): Record<string, unknown> {
  return mockSessionDeleteMany.mock.calls[0][0].where
}

beforeEach(() => {
  jest.clearAllMocks()
  mockSessionDeleteMany.mockResolvedValue({ count: 0 })
})

describe('cleanupExpiredSessions', () => {
  it('deletes in two passes: live sessions, then retained revocations', async () => {
    await cleanupExpiredSessions()
    expect(mockSessionDeleteMany).toHaveBeenCalledTimes(2)
  })

  it('keeps a session whose access token expired but whose refresh token is live', async () => {
    await cleanupExpiredSessions()
    const where = liveSessionFilter()

    expect(where.expiresAt).toEqual({ lt: expect.any(Date) })
    // The refresh-token clause is what stops the silent logout.
    expect(where.OR).toEqual([
      { refreshTokenExpiresAt: null },
      { refreshTokenExpiresAt: { lt: expect.any(Date) } },
    ])
  })

  it('never touches an already-revoked session in the live pass', async () => {
    // Revoked rows are governed solely by the retention window, otherwise a
    // fresh revocation could be deleted before the user ever sees it.
    await cleanupExpiredSessions()
    expect(liveSessionFilter().revokedAt).toBeNull()
  })

  it('purges revoked sessions only after the retention window', async () => {
    await cleanupExpiredSessions()
    const revokedFilter = mockSessionDeleteMany.mock.calls[1][0].where

    expect(revokedFilter.revokedAt).toEqual({
      not: null,
      lt: expect.any(Date),
    })
  })

  it('is idempotent', async () => {
    // Compare shape, not literal timestamps: the job re-evaluates `now` on each
    // run, so identical filters mean identical key sets for the same clock.
    const shape = (where: Record<string, unknown>): string =>
      JSON.stringify(where, (key, value) => (key === 'lt' ? '<date>' : value))

    await cleanupExpiredSessions()
    const first = mockSessionDeleteMany.mock.calls.map((call) =>
      shape(call[0].where)
    )
    await cleanupExpiredSessions()
    const second = mockSessionDeleteMany.mock.calls
      .slice(2)
      .map((call) => shape(call[0].where))

    expect(second).toEqual(first)
  })

  it('swallows database failures so the scheduler is not torn down', async () => {
    mockSessionDeleteMany.mockRejectedValue(new Error('connection lost'))
    await expect(cleanupExpiredSessions()).resolves.toBeUndefined()
  })
})
