jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: {
    accountRecoveryRequest: {
      findFirst: jest.fn(),
    },
    $transaction: jest.fn(),
    user: {
      findUnique: jest.fn(),
    },
    emailIdentity: {
      findUnique: jest.fn(),
    },
  },
}))

jest.mock('../../../src/events/publisher', () => ({
  publishUserEvent: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('../../../src/mail/mailProvider', () => ({
  mailRegistry: { send: jest.fn().mockResolvedValue(undefined) },
}))

jest.mock('../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

import db from '../../../src/db'
import { cancelRecoveryWithEmailToken } from '../../../src/recovery/service'

const mockDb = db as unknown as {
  accountRecoveryRequest: { findFirst: jest.Mock }
  $transaction: jest.Mock
  user: { findUnique: jest.Mock }
}

describe('cancelRecoveryWithEmailToken', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('cancels once using the hash of the emailed token', async () => {
    const token = 'a'.repeat(43)
    const tx = {
      $executeRaw: jest.fn(),
      accountRecoveryRequest: {
        findFirst: jest.fn().mockResolvedValue({ id: 'request-1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      adminAuditLog: { create: jest.fn().mockResolvedValue({}) },
    }
    mockDb.accountRecoveryRequest.findFirst
      .mockResolvedValueOnce({ userId: 'owner-1' })
      .mockResolvedValueOnce(null)
    mockDb.$transaction.mockImplementation(
      async (callback: (transaction: typeof tx) => Promise<boolean>) =>
        callback(tx)
    )
    mockDb.user.findUnique.mockResolvedValue({
      emailIdentity: { email: 'owner@example.test', status: 'VERIFIED' },
      recoveryPolicy: { guardians: [] },
    })

    await expect(
      cancelRecoveryWithEmailToken('request-1', token)
    ).resolves.toBe(true)
    await expect(
      cancelRecoveryWithEmailToken('request-1', token)
    ).resolves.toBe(false)

    expect(
      mockDb.accountRecoveryRequest.findFirst.mock.calls[0][0].where
        .cancelTokenHash
    ).toBe(
      require('node:crypto').createHash('sha256').update(token).digest('hex')
    )
    expect(tx.accountRecoveryRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'CANCELLED',
          cancelTokenHash: null,
          cancelTokenExpiresAt: null,
        }),
      })
    )
  })
})
