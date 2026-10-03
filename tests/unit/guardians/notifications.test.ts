/**
 * Guardian recovery notification tests (#535).
 *
 * Two properties matter here, and both are about FAILURE:
 *
 *   1. The owner alert is unconditional. If a claimant has compromised every
 *      guardian, the owner's alert is the only thing left standing between that
 *      and a takeover, so every channel is attempted regardless of whether the
 *      others worked.
 *   2. Nothing in this module throws. A mail outage must not be able to abort a
 *      security action that has already been recorded, and the caller must not
 *      have to wrap every call in a try/catch to get that guarantee.
 */

process.env.NODE_ENV = 'test'

jest.mock('../../../src/db', () => {
  const findUnique = jest.fn()
  const client: any = { user: { findUnique } }
  return {
    __esModule: true,
    default: client,
    db: client,
    __mockFindUnique: findUnique,
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

jest.mock('../../../src/mail/mailProvider', () => ({
  mailRegistry: { send: jest.fn().mockResolvedValue({ messageId: 'm1' }) },
}))

jest.mock('../../../src/utils/twilio-client', () => ({
  sendWhatsAppMessage: jest.fn().mockResolvedValue('SM123'),
}))

jest.mock('../../../src/events/publisher', () => ({
  publishUserEvent: jest.fn().mockResolvedValue(undefined),
}))

import {
  notifyGuardiansOfRequest,
  notifyQuorumReached,
  notifyRecoveryCancelled,
  notifyRecoveryCompleted,
  notifyRecoveryInitiated,
} from '../../../src/guardians/notifications'

const { mailRegistry } = require('../../../src/mail/mailProvider')
const { sendWhatsAppMessage } = require('../../../src/utils/twilio-client')
const { publishUserEvent } = require('../../../src/events/publisher')
const mockFindUnique = require('../../../src/db').__mockFindUnique

const OWNER = 'owner-1'

function ownerContact(overrides: Record<string, unknown> = {}) {
  return {
    id: OWNER,
    email: 'owner@example.com',
    phone: '+15551234567',
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mailRegistry.send.mockResolvedValue({ messageId: 'm1' })
  sendWhatsAppMessage.mockResolvedValue('SM123')
  publishUserEvent.mockResolvedValue(undefined)
})

describe('notifyRecoveryInitiated', () => {
  it('alerts the owner on every available channel', async () => {
    mockFindUnique.mockResolvedValue(ownerContact())

    await notifyRecoveryInitiated({
      requestId: 'r1',
      userId: OWNER,
      reason: 'Lost my phone',
      requiredApprovals: 2,
      acceptedGuardians: 3,
    })

    expect(publishUserEvent).toHaveBeenCalledWith(
      OWNER,
      'alerts',
      'security.recovery_initiated',
      expect.objectContaining({ requestId: 'r1' })
    )
    expect(mailRegistry.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'owner@example.com' })
    )
    expect(sendWhatsAppMessage).toHaveBeenCalledWith(
      expect.objectContaining({ to: '+15551234567' })
    )
  })

  it('still alerts over realtime when the mail provider is down', async () => {
    // Realtime is the channel an attacker cannot intercept, so it is attempted
    // first and its success does not depend on anything else.
    mockFindUnique.mockResolvedValue(ownerContact())
    mailRegistry.send.mockRejectedValue(new Error('SMTP down'))

    await expect(
      notifyRecoveryInitiated({
        requestId: 'r1',
        userId: OWNER,
        reason: 'Lost my phone',
        requiredApprovals: 2,
        acceptedGuardians: 3,
      })
    ).resolves.toBeUndefined()

    expect(publishUserEvent).toHaveBeenCalled()
  })

  it('does not throw when every channel fails', async () => {
    mockFindUnique.mockResolvedValue(ownerContact())
    mailRegistry.send.mockRejectedValue(new Error('SMTP down'))
    sendWhatsAppMessage.mockRejectedValue(new Error('Twilio down'))
    publishUserEvent.mockRejectedValue(new Error('redis down'))

    await expect(
      notifyRecoveryInitiated({
        requestId: 'r1',
        userId: OWNER,
        reason: 'Lost my phone',
        requiredApprovals: 2,
        acceptedGuardians: 3,
      })
    ).resolves.toBeUndefined()
  })

  it('skips a channel the account has no address for, without erroring', async () => {
    mockFindUnique.mockResolvedValue(ownerContact({ email: null, phone: null }))

    await notifyRecoveryInitiated({
      requestId: 'r1',
      userId: OWNER,
      reason: 'Lost my phone',
      requiredApprovals: 2,
      acceptedGuardians: 3,
    })

    expect(mailRegistry.send).not.toHaveBeenCalled()
    expect(sendWhatsAppMessage).not.toHaveBeenCalled()
    expect(publishUserEvent).toHaveBeenCalled()
  })

  it('never puts a raw token in a log line', async () => {
    const { logger } = require('../../../src/utils/logger')
    mockFindUnique.mockResolvedValue(ownerContact())

    await notifyRecoveryInitiated({
      requestId: 'r1',
      userId: OWNER,
      reason: 'Lost my phone',
      requiredApprovals: 2,
      acceptedGuardians: 3,
    })

    const logged = JSON.stringify(logger.error.mock.calls)
    expect(logged).not.toMatch(/[a-f0-9]{32,}/)
  })
})

describe('quorum / completion / cancellation alerts', () => {
  it('tells the owner the exact deadline and that they can still cancel', async () => {
    mockFindUnique.mockResolvedValue(ownerContact())

    await notifyQuorumReached({
      requestId: 'r1',
      userId: OWNER,
      requiredApprovals: 2,
      executeAfter: '2030-01-01T00:00:00.000Z',
    })

    const whatsapp = sendWhatsAppMessage.mock.calls[0][0]
    expect(whatsapp.body).toContain('cancel')
    expect(whatsapp.body).toContain('2030-01-01T00:00:00.000Z')
  })

  it('reports the revoked session count on completion', async () => {
    mockFindUnique.mockResolvedValue(ownerContact())

    await notifyRecoveryCompleted({
      requestId: 'r1',
      userId: OWNER,
      revokedSessions: 4,
      executedAt: '2030-01-01T00:00:00.000Z',
    })

    const whatsapp = sendWhatsAppMessage.mock.calls[0][0]
    expect(whatsapp.body).toContain('4')
    expect(publishUserEvent.mock.calls[0][3]).toMatchObject({
      revokedSessions: 4,
    })
  })

  it('emits the cancellation event', async () => {
    mockFindUnique.mockResolvedValue(ownerContact())

    await notifyRecoveryCancelled({
      requestId: 'r1',
      userId: OWNER,
      cancelledAt: '2030-01-01T00:00:00.000Z',
    })

    expect(publishUserEvent).toHaveBeenCalledWith(
      OWNER,
      'alerts',
      'security.recovery_cancelled',
      expect.objectContaining({ requestId: 'r1' })
    )
  })
})

describe('notifyGuardiansOfRequest', () => {
  const base = {
    requestId: 'r1',
    userId: OWNER,
    accountHint: 'GA***WF',
    reason: 'Lost my phone',
    requiredApprovals: 2,
    expiresAt: '2030-01-01T00:00:00.000Z',
  }

  it('asks a platform guardian to sign in rather than sending a token', async () => {
    mockFindUnique.mockResolvedValue(ownerContact())

    await notifyGuardiansOfRequest({
      ...base,
      guardians: [
        {
          id: 'g1',
          guardianUserId: 'platform-1',
          externalEmail: null,
          externalPhone: null,
          inviteToken: null,
        },
      ],
    })

    expect(publishUserEvent).toHaveBeenCalledWith(
      'platform-1',
      'alerts',
      'security.guardian_approval_requested',
      expect.objectContaining({ requestId: 'r1' })
    )
    expect(mailRegistry.send).not.toHaveBeenCalled()
  })

  it('gives an external guardian a link scoped to their own token', async () => {
    mockFindUnique.mockResolvedValue(ownerContact())

    await notifyGuardiansOfRequest({
      ...base,
      guardians: [
        {
          id: 'g1',
          guardianUserId: null,
          externalEmail: 'friend@example.com',
          externalPhone: null,
          inviteToken: 'their-own-token',
        },
      ],
    })

    const message = mailRegistry.send.mock.calls[0][0]
    expect(message.to).toBe('friend@example.com')
    expect(message.html).toContain('their-own-token')
  })

  it('never sends one guardian another guardian’s token', async () => {
    mockFindUnique.mockResolvedValue(ownerContact())

    await notifyGuardiansOfRequest({
      ...base,
      guardians: [
        {
          id: 'g1',
          guardianUserId: null,
          externalEmail: 'a@example.com',
          externalPhone: null,
          inviteToken: 'token-a',
        },
        {
          id: 'g2',
          guardianUserId: null,
          externalEmail: 'b@example.com',
          externalPhone: null,
          inviteToken: 'token-b',
        },
      ],
    })

    const messageA = mailRegistry.send.mock.calls.find(
      (c: any[]) => c[0].to === 'a@example.com'
    )[0]
    const messageB = mailRegistry.send.mock.calls.find(
      (c: any[]) => c[0].to === 'b@example.com'
    )[0]

    expect(messageA.html).toContain('token-a')
    expect(messageA.html).not.toContain('token-b')
    expect(messageB.html).toContain('token-b')
    expect(messageB.html).not.toContain('token-a')
  })

  it('still alerts the remaining guardians when one delivery fails', async () => {
    mockFindUnique.mockResolvedValue(ownerContact())
    mailRegistry.send
      .mockRejectedValueOnce(new Error('first bounced'))
      .mockResolvedValue({ messageId: 'm2' })

    await expect(
      notifyGuardiansOfRequest({
        ...base,
        guardians: [
          {
            id: 'g1',
            guardianUserId: null,
            externalEmail: 'a@example.com',
            externalPhone: null,
            inviteToken: 'token-a',
          },
          {
            id: 'g2',
            guardianUserId: null,
            externalEmail: 'b@example.com',
            externalPhone: null,
            inviteToken: 'token-b',
          },
        ],
      })
    ).resolves.toBeUndefined()

    expect(mailRegistry.send).toHaveBeenCalledTimes(2)
  })

  it('does not throw when an external guardian has no token on file', async () => {
    mockFindUnique.mockResolvedValue(ownerContact())

    await expect(
      notifyGuardiansOfRequest({
        ...base,
        guardians: [
          {
            id: 'g1',
            guardianUserId: null,
            externalEmail: 'a@example.com',
            externalPhone: null,
            inviteToken: null,
          },
        ],
      })
    ).resolves.toBeUndefined()
  })
})
