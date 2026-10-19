import db from '../../../src/db'
import {
  completeRecoveryRequest,
  hashRecoveryToken,
  RECOVERY_DELAY_HOURS,
} from '../../../src/services/account-recovery.service'
import { dispatchOutboundNotifications } from '../../../src/services/outboundNotifications'
import { closeUserSockets } from '../../../src/ws/server'
import { invalidateAllUserCaches } from '../../../src/utils/user-cache-invalidation'
import { publishUserEvent } from '../../../src/events/publisher'

jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(),
    emailIdentity: { findUnique: jest.fn() },
  },
}))
jest.mock('../../../src/services/outboundNotifications', () => ({
  dispatchOutboundNotifications: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../../../src/ws/server', () => ({
  closeUserSockets: jest.fn(),
}))
jest.mock('../../../src/utils/user-cache-invalidation', () => ({
  invalidateAllUserCaches: jest.fn(),
}))
jest.mock('../../../src/events/publisher', () => ({
  publishUserEvent: jest.fn(),
}))
jest.mock('../../../src/utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn() },
}))

const mockDb = db as unknown as {
  $transaction: jest.Mock
  emailIdentity: { findUnique: jest.Mock }
}

function transactionClient() {
  return {
    $queryRaw: jest.fn(),
    recoveryRequest: {
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    recoveryPolicy: { findUnique: jest.fn() },
    user: { findFirst: jest.fn(), update: jest.fn() },
    session: { updateMany: jest.fn() },
    userApiKey: { updateMany: jest.fn() },
    totpCredential: { deleteMany: jest.fn() },
    webAuthnCredential: { deleteMany: jest.fn() },
    adminAuditLog: { create: jest.fn() },
    outboundNotification: { create: jest.fn() },
  }
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe('account recovery service', () => {
  it('uses a fixed 72-hour delay and hashes cancellation tokens', () => {
    const token = 'a'.repeat(64)
    expect(RECOVERY_DELAY_HOURS).toBe(72)
    expect(hashRecoveryToken(token)).toBe(hashRecoveryToken(token))
    expect(hashRecoveryToken(token)).not.toBe(token)
  })

  it('changes only the sign-in key and invalidates all other credentials at completion', async () => {
    const tx = transactionClient()
    tx.recoveryRequest.findFirst.mockResolvedValue({
      id: 'request-1',
      ownerUserId: 'owner-1',
      proposedAuthPublicKey: 'GNEWKEY',
      owner: { id: 'owner-1', isActive: true, walletAddress: 'GASSETWALLET' },
      approvals: [{ id: 'approval-1' }, { id: 'approval-2' }],
      quorumReachedAt: new Date(Date.now() - 73 * 60 * 60 * 1000),
    })
    tx.recoveryPolicy.findUnique.mockResolvedValue({ requiredApprovals: 2 })
    tx.user.findFirst.mockResolvedValue(null)
    tx.session.updateMany.mockResolvedValue({ count: 3 })
    tx.userApiKey.updateMany.mockResolvedValue({ count: 2 })
    tx.totpCredential.deleteMany.mockResolvedValue({ count: 1 })
    tx.webAuthnCredential.deleteMany.mockResolvedValue({ count: 2 })
    mockDb.$transaction.mockImplementation((work) => work(tx))
    mockDb.emailIdentity.findUnique.mockResolvedValue(null)

    await expect(completeRecoveryRequest('request-1')).resolves.toBe(true)

    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'owner-1' },
      data: { authPublicKey: 'GNEWKEY' },
    })
    expect(tx.session.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'owner-1', revokedAt: null },
        data: expect.objectContaining({
          revokedAt: expect.any(Date),
          revokedReason: 'account_recovery',
          refreshTokenHash: null,
        }),
      })
    )
    expect(tx.userApiKey.updateMany).toHaveBeenCalled()
    expect(tx.totpCredential.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'owner-1' },
    })
    expect(tx.webAuthnCredential.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'owner-1' },
    })
    expect(tx.adminAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'RECOVERY_COMPLETED',
          target: 'owner-1',
          details: expect.objectContaining({
            sessionsRevoked: 3,
            apiKeysRevoked: 2,
            totpCredentialsReset: 1,
            passkeysRemoved: 2,
          }),
        }),
      })
    )
    expect(closeUserSockets).toHaveBeenCalledWith(
      'owner-1',
      'Account recovery completed'
    )
    expect(invalidateAllUserCaches).toHaveBeenCalledWith('owner-1')
    expect(publishUserEvent).toHaveBeenCalledWith(
      'owner-1',
      'alerts',
      'security.recovery_completed',
      expect.any(Object)
    )
    expect(dispatchOutboundNotifications).toHaveBeenCalled()
  })

  it('does not change credentials before the cooling-off deadline', async () => {
    const tx = transactionClient()
    tx.recoveryRequest.findFirst.mockResolvedValue(null)
    mockDb.$transaction.mockImplementation((work) => work(tx))

    await expect(completeRecoveryRequest('request-1')).resolves.toBe(false)

    expect(tx.user.update).not.toHaveBeenCalled()
    expect(tx.session.updateMany).not.toHaveBeenCalled()
    expect(closeUserSockets).not.toHaveBeenCalled()
  })
})
