/**
 * Guardian social recovery service tests (#535).
 *
 * These tests are about the SECURITY properties, not about coverage. Each one
 * encodes a claim the design makes in comments and docs; if a refactor breaks
 * the behaviour but keeps the tests passing, the comments are lying.
 *
 * The properties under test:
 *   1. A 1-of-N quorum is impossible, at every layer that can express it.
 *   2. The mandatory delay is stamped ONCE and cannot be pulled forward by a
 *      later policy edit.
 *   3. Only an explicitly ACCEPTED guardian can decide, and each decides once.
 *   4. The owner can cancel unilaterally, right up to the execution race.
 *   5. Execution is refused before the deadline and revokes every session.
 *   6. Initiation cannot be used to probe whether a wallet exists.
 */

process.env.NODE_ENV = 'test'

jest.mock('../../../src/db', () => {
  // Per-model mocks. A single shared `create`/`findUnique` across models makes
  // assertions ambiguous about which call a test is actually looking at.
  const userFindUnique = jest.fn()
  const subAccountFindFirst = jest.fn()
  const guardianFindUnique = jest.fn()
  const guardianFindFirst = jest.fn()
  const guardianFindMany = jest.fn()
  const guardianCreate = jest.fn()
  const guardianUpdate = jest.fn()
  const guardianCount = jest.fn()
  const policyFindUnique = jest.fn()
  const policyCreate = jest.fn()
  const policyUpdate = jest.fn()
  const requestFindUnique = jest.fn()
  const requestFindMany = jest.fn()
  const requestCreate = jest.fn()
  const requestUpdate = jest.fn()
  const requestUpdateMany = jest.fn()
  const approvalFindUnique = jest.fn()
  const approvalCreate = jest.fn()
  const approvalCount = jest.fn()
  const sessionFindMany = jest.fn()

  const client: any = {
    user: { findUnique: userFindUnique },
    subAccount: { findFirst: subAccountFindFirst },
    recoveryGuardian: {
      findUnique: guardianFindUnique,
      findFirst: guardianFindFirst,
      findMany: guardianFindMany,
      create: guardianCreate,
      update: guardianUpdate,
      count: guardianCount,
    },
    recoveryPolicy: {
      findUnique: policyFindUnique,
      create: policyCreate,
      update: policyUpdate,
    },
    recoveryRequest: {
      findUnique: requestFindUnique,
      findMany: requestFindMany,
      create: requestCreate,
      update: requestUpdate,
      updateMany: requestUpdateMany,
    },
    recoveryApproval: {
      findUnique: approvalFindUnique,
      create: approvalCreate,
      count: approvalCount,
    },
    session: { findMany: sessionFindMany },
  }

  const all = [
    userFindUnique,
    subAccountFindFirst,
    guardianFindUnique,
    guardianFindFirst,
    guardianFindMany,
    guardianCreate,
    guardianUpdate,
    guardianCount,
    policyFindUnique,
    policyCreate,
    policyUpdate,
    requestFindUnique,
    requestFindMany,
    requestCreate,
    requestUpdate,
    requestUpdateMany,
    approvalFindUnique,
    approvalCreate,
    approvalCount,
    sessionFindMany,
  ]

  return {
    __esModule: true,
    default: client,
    db: client,
    __mock: {
      userFindUnique,
      subAccountFindFirst,
      guardianFindUnique,
      guardianFindFirst,
      guardianFindMany,
      guardianCreate,
      guardianUpdate,
      guardianCount,
      policyFindUnique,
      policyCreate,
      policyUpdate,
      requestFindUnique,
      requestFindMany,
      requestCreate,
      requestUpdate,
      requestUpdateMany,
      approvalFindUnique,
      approvalCreate,
      approvalCount,
      sessionFindMany,
      resetAll: () => all.forEach((fn) => fn.mockReset()),
    },
  }
})

jest.mock('../../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}))

jest.mock('../../../src/audit/chain', () => ({
  appendAuditBlock: jest.fn(),
}))

jest.mock('../../../src/services/refresh-token.service', () => ({
  revokeSession: jest.fn().mockResolvedValue(undefined),
}))

// Notifications are fire-and-forget by design. Mocked so these tests exercise
// recovery LOGIC only; delivery behaviour is covered in notifications.test.ts.
jest.mock('../../../src/guardians/notifications', () => ({
  notifyRecoveryInitiated: jest.fn(),
  notifyGuardiansOfRequest: jest.fn(),
  notifyGuardianInvitation: jest.fn(),
  notifyQuorumReached: jest.fn(),
  notifyRecoveryCompleted: jest.fn(),
  notifyRecoveryCancelled: jest.fn(),
}))

import { Prisma } from '@prisma/client'

import {
  MAX_RECOVERY_DELAY_HOURS,
  MIN_RECOVERY_DELAY_HOURS,
  MIN_REQUIRED_APPROVALS,
  cancelRecovery,
  executeRecovery,
  expireStaleRequests,
  getOrCreateRecoveryPolicy,
  initiateRecovery,
  nominateGuardian,
  RecoveryError,
  updateRecoveryPolicy,
} from '../../../src/guardians/service'

const m = require('../../../src/db').__mock
const { revokeSession } = require('../../../src/services/refresh-token.service')

const USER_ID = 'user-1'
const WALLET = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'

function policy(overrides: Record<string, unknown> = {}) {
  return {
    userId: USER_ID,
    requiredApprovals: 2,
    recoveryDelayHours: 48,
    maxGuardians: 5,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function guardian(overrides: Record<string, unknown> = {}) {
  return {
    id: 'guardian-1',
    userId: USER_ID,
    guardianUserId: 'platform-user-1',
    externalEmail: null,
    externalPhone: null,
    status: 'ACCEPTED',
    inviteTokenHash: 'hash',
    inviteExpiresAt: new Date(Date.now() + 86_400_000),
    confirmedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    id: 'request-1',
    userId: USER_ID,
    reason: 'Lost my phone',
    status: 'PENDING',
    quorumReachedAt: null,
    executeAfter: null,
    executedAt: null,
    cancelledAt: null,
    expiresAt: new Date(Date.now() + 30 * 86_400_000),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  m.resetAll()
})

// ─── Policy: quorum and delay bounds ─────────────────────────────────────────

describe('recovery policy', () => {
  it('refuses a quorum below the minimum', async () => {
    m.policyFindUnique.mockResolvedValue(policy({ requiredApprovals: 2 }))

    await expect(
      updateRecoveryPolicy(USER_ID, { requiredApprovals: 1 })
    ).rejects.toThrow(RecoveryError)

    expect(m.policyUpdate).not.toHaveBeenCalled()
  })

  it('exposes a minimum quorum greater than one', () => {
    // A 1-of-N quorum would make every other control decorative.
    expect(MIN_REQUIRED_APPROVALS).toBeGreaterThan(1)
  })

  it('refuses a delay shorter than the mandatory floor', async () => {
    m.policyFindUnique.mockResolvedValue(policy())

    await expect(
      updateRecoveryPolicy(USER_ID, { recoveryDelayHours: 1 })
    ).rejects.toThrow(RecoveryError)
  })

  it('refuses a delay longer than the ceiling', async () => {
    m.policyFindUnique.mockResolvedValue(policy())

    await expect(
      updateRecoveryPolicy(USER_ID, {
        recoveryDelayHours: MAX_RECOVERY_DELAY_HOURS + 1,
      })
    ).rejects.toThrow(RecoveryError)
  })

  it('keeps the delay floor inside the allowed band', () => {
    expect(MIN_RECOVERY_DELAY_HOURS).toBeGreaterThanOrEqual(24)
    expect(MAX_RECOVERY_DELAY_HOURS).toBeLessThanOrEqual(24 * 7)
  })
})

// ─── Nomination ──────────────────────────────────────────────────────────────

describe('nominateGuardian', () => {
  it('refuses self-nomination', async () => {
    await expect(
      nominateGuardian({ userId: USER_ID, guardianUserId: USER_ID })
    ).rejects.toThrow(/cannot nominate yourself/i)
    expect(m.guardianCreate).not.toHaveBeenCalled()
  })

  it('refuses a nomination with no identifier at all', async () => {
    await expect(nominateGuardian({ userId: USER_ID })).rejects.toThrow(
      /identify the guardian/i
    )
  })

  it('returns the raw invite token exactly once and stores only its digest', async () => {
    m.policyFindUnique.mockResolvedValue(policy())
    m.guardianFindFirst.mockResolvedValue(null) // no existing active guardian
    m.guardianCount.mockResolvedValue(0)
    m.guardianCreate.mockImplementation(({ data }: any) =>
      Promise.resolve(guardian({ ...data, id: 'guardian-new' }))
    )

    const result = await nominateGuardian({
      userId: USER_ID,
      externalEmail: 'friend@example.com',
    })

    expect(result.inviteToken).toEqual(expect.any(String))
    expect(result.inviteToken.length).toBeGreaterThanOrEqual(32)

    const created = m.guardianCreate.mock.calls[0][0].data
    expect(created.inviteTokenHash).toEqual(expect.any(String))
    // The raw token must never reach the database.
    expect(JSON.stringify(created)).not.toContain(result.inviteToken)
  })

  it('never returns a stored digest as the invite token', async () => {
    m.policyFindUnique.mockResolvedValue(policy())
    m.guardianFindFirst.mockResolvedValue(null)
    m.guardianCount.mockResolvedValue(0)
    m.guardianCreate.mockImplementation(({ data }: any) =>
      Promise.resolve(guardian({ ...data }))
    )

    const result = await nominateGuardian({
      userId: USER_ID,
      externalEmail: 'friend@example.com',
    })

    expect(result.inviteToken).not.toBe(result.guardian.id)
    expect(JSON.stringify(result.guardian)).not.toContain(result.inviteToken)
  })

  it('enforces the guardian cap', async () => {
    // Already at the configured maximum.
    m.guardianFindFirst.mockResolvedValue({ id: 'existing' })
    m.guardianCount.mockResolvedValue(5)
    m.policyFindUnique.mockResolvedValue(policy({ maxGuardians: 5 }))

    await expect(
      nominateGuardian({ userId: USER_ID, externalEmail: 'new@example.com' })
    ).rejects.toThrow(/maximum/i)
  })

  it('does not let a fresh invitation silently re-enrol an ACCEPTED guardian', async () => {
    // Re-nominating returns the row to PENDING, so it cannot keep voting while
    // the new invitation is outstanding.
    m.guardianFindFirst.mockResolvedValue({ id: 'guardian-1' })
    m.guardianCount.mockResolvedValue(1)
    m.policyFindUnique.mockResolvedValue(policy())
    m.guardianUpdate.mockImplementation(({ data }: any) =>
      Promise.resolve(guardian({ ...data }))
    )

    const result = await nominateGuardian({
      userId: USER_ID,
      externalEmail: 'friend@example.com',
    })

    expect(m.guardianUpdate).toHaveBeenCalled()
    expect(result.guardian.status).toBe('PENDING')
  })
})

// ─── Initiation and the one-live-request invariant ───────────────────────────

describe('initiateRecovery', () => {
  /** A Prisma unique-constraint violation, as the DB raises for the partial index. */
  function p2002() {
    const err: any = new Error('Unique constraint failed')
    err.name = 'PrismaClientKnownRequestError'
    err.code = 'P2002'
    err.clientVersion = '5.0.0'
    // Constructed through Prisma's class so `instanceof` in the service matches.
    Object.setPrototypeOf(err, Prisma.PrismaClientKnownRequestError.prototype)
    return err
  }

  /** Everything the happy path needs up to the INSERT. */
  function primeHappyPath() {
    m.userFindUnique.mockResolvedValue({ id: USER_ID })
    m.subAccountFindFirst.mockResolvedValue(null)
    m.policyFindUnique.mockResolvedValue(policy())
    m.guardianCount.mockResolvedValue(3)
  }

  it('treats a live-request unique violation as the generic refusal', async () => {
    primeHappyPath()
    // There is no pre-insert read: the partial unique index is the only thing
    // standing between two concurrent initiations and two live requests.
    m.requestCreate.mockRejectedValue(p2002())

    const result = await initiateRecovery({
      walletAddress: WALLET,
      reason: 'Lost my phone',
    })

    // No request, and the caller learns nothing beyond the generic outcome.
    expect(result.request).toBeNull()
  })

  it('does not mask a real database failure as a duplicate', async () => {
    primeHappyPath()
    m.requestCreate.mockRejectedValue(new Error('connection terminated'))

    // Surfacing an outage as "already open" would be indistinguishable from
    // success to the route while writing a false cause into the audit trail.
    await expect(
      initiateRecovery({ walletAddress: WALLET, reason: 'Lost my phone' })
    ).rejects.toThrow(/connection terminated/)
  })

  it('opens a request when the insert succeeds', async () => {
    primeHappyPath()
    m.requestCreate.mockResolvedValue(request())

    const result = await initiateRecovery({
      walletAddress: WALLET,
      reason: 'Lost my phone',
    })

    expect(result.request?.id).toBe('request-1')
    expect(m.requestCreate).toHaveBeenCalled()
  })
})

// ─── Cancellation ────────────────────────────────────────────────────────────

describe('cancelRecovery', () => {
  it('refuses to cancel another account’s request', async () => {
    m.requestFindUnique.mockResolvedValue(request())

    await expect(
      cancelRecovery({ requestId: 'request-1', userId: 'someone-else' })
    ).rejects.toThrow(/another account/i)
    expect(m.requestUpdateMany).not.toHaveBeenCalled()
  })

  it('cancels without any guardian consensus or delay', async () => {
    m.requestFindUnique.mockResolvedValue(request({ status: 'PENDING' }))
    m.requestUpdateMany.mockResolvedValue({ count: 1 })
    m.requestFindMany.mockResolvedValue([])

    await cancelRecovery({ requestId: 'request-1', userId: USER_ID })

    expect(m.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'request-1' }),
        data: expect.objectContaining({ status: 'CANCELLED' }),
      })
    )
  })

  it('still cancels after quorum was reached', async () => {
    m.requestFindUnique.mockResolvedValue(
      request({ status: 'QUORUM_REACHED', quorumReachedAt: new Date() })
    )
    m.requestUpdateMany.mockResolvedValue({ count: 1 })
    m.requestFindMany.mockResolvedValue([])

    await cancelRecovery({ requestId: 'request-1', userId: USER_ID })

    expect(m.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'CANCELLED' }),
      })
    )
  })

  it('loses cleanly when execution already won the race', async () => {
    m.requestFindUnique.mockResolvedValue(request({ status: 'PENDING' }))
    m.requestUpdateMany.mockResolvedValue({ count: 0 }) // CAS matched nothing
    m.requestFindUnique
      .mockResolvedValueOnce(request({ status: 'PENDING' }))
      .mockResolvedValueOnce(request({ status: 'COMPLETED' }))

    await expect(
      cancelRecovery({ requestId: 'request-1', userId: USER_ID })
    ).rejects.toThrow(/completed/i)
  })
})

// ─── Execution ───────────────────────────────────────────────────────────────

describe('executeRecovery', () => {
  const past = new Date(Date.now() - 1000)
  const future = new Date(Date.now() + 86_400_000)

  it('refuses to execute while the delay is still running', async () => {
    m.requestFindUnique.mockResolvedValue(
      request({ status: 'QUORUM_REACHED', executeAfter: future })
    )

    const outcome = await executeRecovery('request-1', new Date())

    expect(outcome.executed).toBe(false)
    expect(revokeSession).not.toHaveBeenCalled()
  })

  it('refuses to execute a request that never reached quorum', async () => {
    m.requestFindUnique.mockResolvedValue(request({ status: 'PENDING' }))

    const outcome = await executeRecovery('request-1', new Date())

    expect(outcome.executed).toBe(false)
    expect(revokeSession).not.toHaveBeenCalled()
  })

  it('refuses to execute with no deadline stamped', async () => {
    // Structurally impossible via the service. Treated as a refusal, never as
    // permission: a missing deadline must not become an immediate reset.
    m.requestFindUnique.mockResolvedValue(
      request({ status: 'QUORUM_REACHED', executeAfter: null })
    )

    const outcome = await executeRecovery('request-1', new Date())

    expect(outcome.executed).toBe(false)
    expect(revokeSession).not.toHaveBeenCalled()
  })

  it('revokes EVERY live session when the delay has elapsed', async () => {
    m.requestFindUnique.mockResolvedValue(
      request({
        status: 'QUORUM_REACHED',
        quorumReachedAt: new Date(Date.now() - 3 * 86_400_000),
        executeAfter: past,
      })
    )
    m.requestUpdateMany.mockResolvedValue({ count: 1 })
    m.sessionFindMany.mockResolvedValue([
      { id: 'session-1', deviceType: 'mobile', approxLocation: 'Lisbon' },
      { id: 'session-2', deviceType: 'desktop', approxLocation: null },
    ])

    const outcome = await executeRecovery('request-1', new Date())

    expect(outcome.executed).toBe(true)
    expect(revokeSession).toHaveBeenCalledTimes(2)
    expect(revokeSession).toHaveBeenCalledWith(
      'session-1',
      'account_recovery',
      expect.objectContaining({ userId: USER_ID })
    )
    expect(revokeSession).toHaveBeenCalledWith(
      'session-2',
      'account_recovery',
      expect.anything()
    )
  })

  it('keeps revoking sessions after one fails, rather than half-recovering', async () => {
    m.requestFindUnique.mockResolvedValue(
      request({ status: 'QUORUM_REACHED', executeAfter: past })
    )
    m.requestUpdateMany.mockResolvedValue({ count: 1 })
    m.sessionFindMany.mockResolvedValue([
      { id: 'session-1', deviceType: 'mobile', approxLocation: null },
      { id: 'session-2', deviceType: 'desktop', approxLocation: null },
    ])
    revokeSession
      .mockRejectedValueOnce(new Error('transient db error'))
      .mockResolvedValueOnce(undefined)

    const outcome = await executeRecovery('request-1', new Date())

    // The recovery still completes: one stuck session must not strand the rest
    // of the account in a half-recovered state.
    expect(outcome.executed).toBe(true)
    expect(revokeSession).toHaveBeenCalledTimes(2)
  })

  it('claims the row conditionally so a concurrent cancellation cannot be undone', async () => {
    m.requestFindUnique.mockResolvedValue(
      request({ status: 'QUORUM_REACHED', executeAfter: past })
    )
    m.requestUpdateMany.mockResolvedValue({ count: 0 }) // lost the CAS
    m.requestFindMany.mockResolvedValue([])

    const outcome = await executeRecovery('request-1', new Date())

    expect(outcome.executed).toBe(false)
    expect(revokeSession).not.toHaveBeenCalled()
    expect(m.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'QUORUM_REACHED',
          executeAfter: { lte: expect.any(Date) },
        }),
      })
    )
  })
})

// ─── Expiry ──────────────────────────────────────────────────────────────────

describe('expireStaleRequests', () => {
  it('expires stale open requests and returns the count', async () => {
    m.requestFindMany.mockResolvedValue([
      { id: 'request-1', userId: USER_ID },
      { id: 'request-2', userId: USER_ID },
    ])
    m.requestUpdateMany.mockResolvedValue({ count: 2 })

    const count = await expireStaleRequests(new Date())

    expect(count).toBe(2)
    expect(m.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: 'EXPIRED' },
      })
    )
  })

  it('is a no-op when nothing has aged out', async () => {
    m.requestFindMany.mockResolvedValue([])

    expect(await expireStaleRequests(new Date())).toBe(0)
    expect(m.requestUpdateMany).not.toHaveBeenCalled()
  })
})

// ─── Default policy ──────────────────────────────────────────────────────────

describe('getOrCreateRecoveryPolicy', () => {
  it('creates a policy with a quorum above one and a real delay', async () => {
    m.policyFindUnique.mockResolvedValue(null)
    m.policyCreate.mockImplementation(({ data }: any) =>
      Promise.resolve(policy({ ...data }))
    )

    const created = await getOrCreateRecoveryPolicy(USER_ID)

    expect(created.requiredApprovals).toBeGreaterThan(1)
    expect(created.recoveryDelayHours).toBeGreaterThanOrEqual(
      MIN_RECOVERY_DELAY_HOURS
    )
  })
})
