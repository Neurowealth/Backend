// #452 — email verification controller must read the typed auth shape.
//
// The controller previously did `(req as any).user?.id || (req as any).userId`
// and validated the address with `email.includes('@')`. These tests cover the
// three cases named in the issue: unauthorized, invalid email, and the happy
// path persisting only the token hash (mail is mocked so nothing is sent).

process.env.NODE_ENV = 'test'

import type { Network } from '@prisma/client'
import type { Request, Response } from 'express'
import {
  handleMailWebhook,
  requestEmailVerification,
  verifyEmail,
} from '../../../src/controllers/email-identity-controller'
import { emailAddressSchema } from '../../../src/validators/email-validators'
import { mailRegistry } from '../../../src/mail/mailProvider'
import { publishUserEvent } from '../../../src/events/publisher'
import { logger } from '../../../src/utils/logger'

jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: {
    emailIdentity: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
    },
  },
}))

jest.mock('../../../src/mail/mailProvider', () => ({
  mailRegistry: { send: jest.fn(), parseWebhook: jest.fn() },
}))

jest.mock('../../../src/events/publisher', () => ({
  publishUserEvent: jest.fn(),
}))

jest.mock('../../../src/mail/templates', () => ({
  renderEmailVerification: jest.fn(() => ({ to: 'user@example.com' })),
}))

jest.mock('../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

import db from '../../../src/db'

const mockFindUnique = db.emailIdentity.findUnique as jest.Mock
const mockFindFirst = db.emailIdentity.findFirst as jest.Mock
const mockUpsert = db.emailIdentity.upsert as jest.Mock
const mockUpdate = db.emailIdentity.update as jest.Mock
const mockSend = mailRegistry.send as jest.Mock
const mockPublish = publishUserEvent as jest.Mock
const mockParseWebhook = mailRegistry.parseWebhook as jest.Mock

const USER_ID = 'user-1'
const sha256 = (input: string) =>
  require('node:crypto').createHash('sha256').update(input).digest('hex')

function makeRes() {
  const res = {} as Response
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  return res
}

function makeReq(overrides: Partial<Request> = {}) {
  return {
    body: {},
    query: {},
    headers: {},
    ...overrides,
  } as unknown as Request
}

/** Request carrying a real `requireAuth` payload. */
function authedReq(body: unknown = {}) {
  return makeReq({
    body,
    auth: {
      userId: USER_ID,
      sessionId: 'session-1',
      walletAddress: 'GWALLET',
      network: 'PUBLIC' as Network,
    },
  } as Partial<Request>)
}

beforeEach(() => {
  jest.clearAllMocks()
  mockSend.mockResolvedValue(undefined)
  mockPublish.mockResolvedValue(undefined)
  mockUpsert.mockImplementation(
    ({ create }: { create: Record<string, unknown> }) =>
      Promise.resolve({ id: 'ei-1', status: 'PENDING', ...create })
  )
})

describe('requestEmailVerification — authorization', () => {
  it('401s when requireAuth did not attach req.auth', async () => {
    const res = makeRes()

    await requestEmailVerification(makeReq(), res)

    expect(res.status).toHaveBeenCalledWith(401)
    expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' })
    expect(mockUpsert).not.toHaveBeenCalled()
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('uses req.auth.userId for the identity, not a stray req.user', async () => {
    // A legacy `req.user` set by some other middleware must not win.
    const req = authedReq({ email: 'user@example.com' }) as Request & {
      user?: { id: string }
    }
    req.user = { id: 'someone-else' }

    const res = makeRes()
    await requestEmailVerification(req, res)

    expect(mockUpsert).toHaveBeenCalledTimes(1)
    const arg = mockUpsert.mock.calls[0][0]
    expect(arg.where.userId).toBe(USER_ID)
    expect(arg.create.userId).toBe(USER_ID)
  })

  it('falls back to the legacy req.userId when req.auth is absent', async () => {
    const res = makeRes()
    const req = makeReq({
      body: { email: 'user@example.com' },
      userId: USER_ID,
    } as Partial<Request>)

    await requestEmailVerification(req, res)

    expect(mockUpsert.mock.calls[0][0].where.userId).toBe(USER_ID)
    expect(res.status).not.toHaveBeenCalled()
  })
})

describe('requestEmailVerification — validation', () => {
  it.each([
    ['missing email', {}],
    ['empty string', { email: '' }],
    ['whitespace only', { email: '   ' }],
    ['no @ sign', { email: 'not-an-email' }],
    ['non-string', { email: 42 }],
    ['null', { email: null }],
  ])('400s on %s', async (_label, body) => {
    const res = makeRes()

    await requestEmailVerification(authedReq(body), res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(mockUpsert).not.toHaveBeenCalled()
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('normalises the stored address to trimmed lowercase', async () => {
    const res = makeRes()

    await requestEmailVerification(
      authedReq({ email: '  User@Example.COM ' }),
      res
    )

    expect(mockUpsert.mock.calls[0][0].create.email).toBe('user@example.com')
  })
})

describe('requestEmailVerification — happy path', () => {
  it('persists only the token hash, never the raw token', async () => {
    const res = makeRes()

    await requestEmailVerification(
      authedReq({ email: 'user@example.com' }),
      res
    )

    const created = mockUpsert.mock.calls[0][0].create
    expect(created.status).toBe('PENDING')
    expect(created.verifyTokenHash).toMatch(/^[a-f0-9]{64}$/)

    // Recover the raw token from the emailed link and prove it is not part of
    // what we stored — only its SHA-256 is.
    const { renderEmailVerification } = require('../../../src/mail/templates')
    const rawToken = renderEmailVerification.mock.calls[0][1].split('token=')[1]
    expect(JSON.stringify(created)).not.toContain(rawToken)
  })

  it('hashes the emailed token so the link verifies', async () => {
    const res = makeRes()

    await requestEmailVerification(
      authedReq({ email: 'user@example.com' }),
      res
    )

    const { renderEmailVerification } = require('../../../src/mail/templates')
    const rawToken = renderEmailVerification.mock.calls[0][1].split('token=')[1]
    expect(sha256(rawToken)).toBe(
      mockUpsert.mock.calls[0][0].create.verifyTokenHash
    )
  })

  it('sets a 24h expiry', async () => {
    const res = makeRes()
    const before = Date.now()

    await requestEmailVerification(
      authedReq({ email: 'user@example.com' }),
      res
    )

    const expiry = mockUpsert.mock.calls[0][0].create.verifyExpiresAt as Date
    const delta = expiry.getTime() - before
    const DAY_MS = 24 * 60 * 60 * 1000
    // The controller stamps `now + 24h` after the call, so allow a few
    // seconds of slack for how long the async work above took.
    expect(delta).toBeGreaterThan(DAY_MS - 60_000)
    expect(delta).toBeLessThanOrEqual(DAY_MS + 5_000)
  })

  it('sends the mail and returns the identity', async () => {
    const res = makeRes()

    await requestEmailVerification(
      authedReq({ email: 'user@example.com' }),
      res
    )

    expect(mockSend).toHaveBeenCalledTimes(1)
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      message: 'Verification email sent',
      email: 'user@example.com',
      status: 'PENDING',
    })
  })

  it('500s and logs when persistence fails', async () => {
    mockUpsert.mockRejectedValue(new Error('db down'))
    const res = makeRes()

    await requestEmailVerification(
      authedReq({ email: 'user@example.com' }),
      res
    )

    expect(res.status).toHaveBeenCalledWith(500)
    expect(logger.error).toHaveBeenCalled()
    expect(mockSend).not.toHaveBeenCalled()
  })
})

describe('requestEmailVerification — anti-enumeration', () => {
  it('returns generic success without sending when another user verified it', async () => {
    mockFindUnique.mockResolvedValue({
      userId: 'other-user',
      status: 'VERIFIED',
    })
    const res = makeRes()

    await requestEmailVerification(
      authedReq({ email: 'taken@example.com' }),
      res
    )

    expect(res.json).toHaveBeenCalledWith({
      success: true,
      message: 'Verification email sent if address is valid',
    })
    expect(res.status).not.toHaveBeenCalledWith(400)
    expect(mockUpsert).not.toHaveBeenCalled()
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('re-verifies the same user', async () => {
    mockFindUnique.mockResolvedValue({ userId: USER_ID, status: 'VERIFIED' })
    const res = makeRes()

    await requestEmailVerification(
      authedReq({ email: 'mine@example.com' }),
      res
    )

    expect(mockUpsert).toHaveBeenCalledTimes(1)
    expect(mockSend).toHaveBeenCalledTimes(1)
  })
})

describe('verifyEmail', () => {
  it('400s when the token is missing or blank', async () => {
    const res = makeRes()
    await verifyEmail(makeReq({ query: {} }), res)
    expect(res.status).toHaveBeenCalledWith(400)

    const res2 = makeRes()
    await verifyEmail(makeReq({ query: { token: '   ' } }), res2)
    expect(res2.status).toHaveBeenCalledWith(400)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('400s on an unknown or expired token', async () => {
    mockFindFirst.mockResolvedValue(null)
    const res = makeRes()

    await verifyEmail(makeReq({ query: { token: 'raw-token' } }), res)

    expect(mockFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          verifyTokenHash: sha256('raw-token'),
        }),
      })
    )
    expect(res.status).toHaveBeenCalledWith(400)
  })

  it('verifies the identity, clears the token fields and publishes', async () => {
    mockFindFirst.mockResolvedValue({
      id: 'ei-1',
      userId: USER_ID,
      status: 'PENDING',
    })
    mockUpdate.mockResolvedValue({
      id: 'ei-1',
      userId: USER_ID,
      email: 'user@example.com',
      status: 'VERIFIED',
      verifiedAt: new Date('2024-01-01T00:00:00.000Z'),
    })
    const res = makeRes()

    await verifyEmail(makeReq({ query: { token: 'raw-token' } }), res)

    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: 'ei-1' },
      data: {
        status: 'VERIFIED',
        verifiedAt: expect.any(Date),
        verifyTokenHash: null,
        verifyExpiresAt: null,
      },
    })
    expect(mockPublish).toHaveBeenCalledWith(
      USER_ID,
      'alerts',
      'email.verified',
      expect.objectContaining({ email: 'user@example.com' })
    )
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      message: 'Email address verified successfully',
      email: 'user@example.com',
      status: 'VERIFIED',
    })
  })

  it('is idempotent for an already-verified address', async () => {
    mockFindFirst.mockResolvedValue({
      id: 'ei-1',
      userId: USER_ID,
      status: 'VERIFIED',
    })
    const res = makeRes()

    await verifyEmail(makeReq({ query: { token: 'raw-token' } }), res)

    expect(res.json).toHaveBeenCalledWith({
      success: true,
      message: 'Email address is already verified',
    })
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('500s when the update fails', async () => {
    mockFindFirst.mockResolvedValue({ id: 'ei-1', status: 'PENDING' })
    mockUpdate.mockRejectedValue(new Error('db down'))
    const res = makeRes()

    await verifyEmail(makeReq({ query: { token: 'raw-token' } }), res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(logger.error).toHaveBeenCalled()
  })
})

describe('emailAddressSchema', () => {
  it('normalises valid addresses', () => {
    expect(emailAddressSchema.parse('  A@B.CO ')).toBe('a@b.co')
  })

  it.each(['', '   ', 'nope', 'a@b', '@b.co', 'a@'])('rejects %p', (value) => {
    expect(emailAddressSchema.safeParse(value).success).toBe(false)
  })
})

describe('handleMailWebhook (#524)', () => {
  beforeEach(() => {
    mockParseWebhook.mockReset()
    mockFindFirst.mockReset()
    mockUpdate.mockReset()
    mockPublish.mockReset()
  })

  it('200s and marks the identity as BOUNCED on a verified bounce', async () => {
    mockParseWebhook.mockResolvedValue({
      type: 'bounce',
      messageId: 'm-1',
      recipient: 'user@example.com',
      reason: 'Permanent',
    })
    mockFindFirst.mockResolvedValue({
      id: 'ei-1',
      userId: 'user-1',
      email: 'user@example.com',
    })
    mockUpdate.mockResolvedValue({ id: 'ei-1' })
    const res = makeRes()

    await handleMailWebhook(makeReq({ body: {} }), res)

    expect(mockFindFirst).toHaveBeenCalledWith({
      where: { email: 'user@example.com' },
    })
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'ei-1' },
        data: expect.objectContaining({ status: 'BOUNCED' }),
      })
    )
    expect(res.status).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      message: 'Mail webhook processed',
    })
  })

  it('200s and marks the identity as COMPLAINED on a verified complaint', async () => {
    mockParseWebhook.mockResolvedValue({
      type: 'complaint',
      messageId: 'm-2',
      recipient: 'User@Example.COM',
      reason: 'abuse',
    })
    mockFindFirst.mockResolvedValue({
      id: 'ei-1',
      userId: 'user-1',
      email: 'user@example.com',
    })
    const res = makeRes()

    await handleMailWebhook(makeReq({ body: {} }), res)

    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'COMPLAINED' }),
      })
    )
  })

  it('400s when the provider yields no event', async () => {
    mockParseWebhook.mockResolvedValue(null)
    const res = makeRes()

    await handleMailWebhook(makeReq({ body: {} }), res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(mockFindFirst).not.toHaveBeenCalled()
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('401s a tampered delivery that fails SNS signature verification', async () => {
    const error = new Error('SES webhook failed SNS signature verification')
    ;(error as { code?: string }).code = 'SES_WEBHOOK_SIGNATURE_INVALID'
    mockParseWebhook.mockRejectedValue(error)
    const res = makeRes()

    await handleMailWebhook(makeReq({ body: {} }), res)

    expect(res.status).toHaveBeenCalledWith(401)
    expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' })
    // An unauthenticated delivery is never processed.
    expect(mockFindFirst).not.toHaveBeenCalled()
    expect(mockUpdate).not.toHaveBeenCalled()
    expect(mockPublish).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalled()
  })

  it('500s on an unexpected registry failure', async () => {
    mockParseWebhook.mockRejectedValue(new Error('db down'))
    const res = makeRes()

    await handleMailWebhook(makeReq({ body: {} }), res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(logger.error).toHaveBeenCalled()
  })
})
