import request from 'supertest'
import express from 'express'

const mockUserId = '11111111-1111-4111-8111-111111111111'
const mockCredentialId = '22222222-2222-4222-8222-222222222222'
let mockAuthKind = 'session'
const mockChallenges = new Map<string, any>()
const mockCredentials = new Map<string, any>()
const mockUser = {
  id: mockUserId,
  walletAddress: 'GWALLET',
  network: 'TESTNET',
  email: 'user@example.com',
  isActive: true,
}

jest.mock('../../src/middleware/authenticate', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    if (mockAuthKind === 'none') return res.sendStatus(401)
    req.authKind = mockAuthKind
    req.auth = {
      userId: mockUserId,
      sessionId: 'session',
      walletAddress: 'GWALLET',
      network: 'TESTNET',
    }
    next()
  },
}))
jest.mock('@simplewebauthn/server', () => ({
  ...jest.requireActual('@simplewebauthn/server'),
  verifyRegistrationResponse: jest.fn(),
  verifyAuthenticationResponse: jest.fn(),
}))
jest.mock('../../src/services/security-notification.service', () => ({
  notifySecurityEvent: jest.fn(async () => {}),
}))
jest.mock('../../src/events/publisher', () => ({
  publishUserEvent: jest.fn(async () => {}),
}))
jest.mock('../../src/services/totp.service', () => ({
  getActiveTotpCredential: jest.fn(async () => null),
  issueTotpChallenge: jest.fn(async () => ({
    token: 'totp-token',
    expiresAt: new Date(Date.now() + 60000),
  })),
}))
jest.mock('../../src/services/refresh-token.service', () => ({
  issueTokenPair: jest.fn(async () => ({
    accessToken: 'access',
    refreshToken: 'refresh',
    expiresAt: new Date(Date.now() + 60000),
    refreshExpiresAt: new Date(Date.now() + 3600000),
  })),
  newRefreshTokenFields: jest.fn(() => ({
    refreshTokenHash: 'hashed-refresh',
  })),
}))
jest.mock('../../src/db', () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn(async () => mockUser) },
    webAuthnChallenge: {
      create: jest.fn(async ({ data }: any) => {
        mockChallenges.set(data.challenge, data)
        return data
      }),
      deleteMany: jest.fn(async ({ where }: any) => {
        if (!where.challenge) return { count: 0 }
        const stored = mockChallenges.get(where.challenge)
        if (
          !stored ||
          stored.purpose !== where.purpose ||
          stored.expiresAt <= new Date() ||
          (where.sessionId && stored.sessionId !== where.sessionId) ||
          (where.userId && stored.userId !== where.userId) ||
          (where.OR &&
            stored.userId &&
            !where.OR.some((clause: any) => clause.userId === stored.userId))
        )
          return { count: 0 }
        mockChallenges.delete(where.challenge)
        return { count: 1 }
      }),
    },
    webAuthnCredential: {
      findMany: jest.fn(async ({ where, select }: any) =>
        [...mockCredentials.values()]
          .filter((c) => c.userId === where.userId)
          .map((c) =>
            select
              ? Object.fromEntries(
                  Object.keys(select).map((key) => [key, c[key]])
                )
              : c
          )
      ),
      findUnique: jest.fn(async ({ where }: any) =>
        [...mockCredentials.values()].find(
          (c) => c.credentialId === where.credentialId
        )
      ),
      create: jest.fn(async ({ data }: any) => {
        const c = { ...data, id: mockCredentialId, user: mockUser }
        mockCredentials.set(c.id, c)
        return c
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const c = mockCredentials.get(where.id)
        if (!c || c.signCount !== where.signCount) return { count: 0 }
        Object.assign(c, data)
        return { count: 1 }
      }),
      deleteMany: jest.fn(async ({ where }: any) => {
        const c = mockCredentials.get(where.id)
        if (!c || c.userId !== where.userId) return { count: 0 }
        mockCredentials.delete(c.id)
        return { count: 1 }
      }),
    },
    session: {
      create: jest.fn(async ({ data }: any) => ({
        ...data,
        id: 'new-session',
        createdAt: new Date(),
      })),
    },
  },
}))

import webAuthnRouter from '../../src/routes/webauthn'
import db from '../../src/db'
import {
  verifyRegistrationResponse,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server'
import { notifySecurityEvent } from '../../src/services/security-notification.service'
import { getActiveTotpCredential } from '../../src/services/totp.service'

const registration = {
  id: 'credential',
  rawId: 'credential',
  type: 'public-key',
  clientExtensionResults: {},
  response: { clientDataJSON: 'e30', attestationObject: 'e30' },
}
const assertion = {
  id: 'credential',
  rawId: 'credential',
  type: 'public-key',
  clientExtensionResults: {},
  response: {
    clientDataJSON: 'e30',
    authenticatorData: 'e30',
    signature: 'e30',
  },
}
const buildApp = () => {
  const app = express()
  app.use(express.json())
  app.use('/api/v1/auth/webauthn', webAuthnRouter)
  app.use('/api/v1/webauthn', webAuthnRouter)
  return app
}
const credential = (counter = 1n) =>
  mockCredentials.set(mockCredentialId, {
    id: mockCredentialId,
    userId: mockUserId,
    credentialId: 'credential',
    publicKey: 'cHVibGlj',
    signCount: counter,
    user: mockUser,
    deviceLabel: 'Passkey',
  })
const login = async (app: express.Express, userId?: string) => {
  const options = await request(app)
    .post('/api/v1/auth/webauthn/login-options')
    .send(userId ? { userId } : {})
  return {
    challengeId: options.body.challengeId,
    response: assertion,
    ...(userId ? { userId } : {}),
  }
}

describe('passkey security and session integration', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockChallenges.clear()
    mockCredentials.clear()
    mockAuthKind = 'session'
    process.env.WEBAUTHN_RP_ID = 'localhost'
    process.env.WEBAUTHN_ORIGIN = 'http://localhost:3000'
    ;(verifyRegistrationResponse as jest.Mock).mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: {
          id: 'credential',
          publicKey: new Uint8Array([1, 2]),
          counter: 1,
          transports: ['internal'],
        },
      },
    })
    ;(verifyAuthenticationResponse as jest.Mock).mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 2 },
    })
    ;(getActiveTotpCredential as jest.Mock).mockResolvedValue(null)
  })
  afterAll(() => {
    delete process.env.WEBAUTHN_RP_ID
    delete process.env.WEBAUTHN_ORIGIN
  })
  it('requires an active session for registration and credential management', async () => {
    const app = buildApp()
    mockAuthKind = 'apiKey'
    expect(
      (await request(app).post('/api/v1/webauthn/register-options').send({}))
        .status
    ).toBe(401)
    expect(
      (await request(app).get('/api/v1/webauthn/credentials')).status
    ).toBe(401)
    mockAuthKind = 'none'
    expect(
      (await request(app).post('/api/v1/webauthn/register-options').send({}))
        .status
    ).toBe(401)
  })
  it('registers only against configured RP/origin and a one-time session challenge', async () => {
    const app = buildApp()
    const options = await request(app)
      .post('/api/v1/webauthn/register-options')
      .set('Host', 'attacker.example')
      .send({})
    const body = {
      challengeId: options.body.challengeId,
      response: registration,
      deviceLabel: 'Face ID',
    }
    expect(options.body.options.rp.id).toBe('localhost')
    expect(
      (await request(app).post('/api/v1/webauthn/register-verify').send(body))
        .status
    ).toBe(201)
    expect(verifyRegistrationResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedOrigin: 'http://localhost:3000',
        expectedRPID: 'localhost',
        requireUserVerification: true,
      })
    )
    expect(notifySecurityEvent).toHaveBeenCalledWith(
      mockUserId,
      'passkey.registered',
      expect.anything()
    )
    expect(
      (await request(app).post('/api/v1/webauthn/register-verify').send(body))
        .status
    ).toBe(400)
  })
  it('rejects registration challenges issued to a different session', async () => {
    const app = buildApp()
    const options = await request(app)
      .post('/api/v1/webauthn/register-options')
      .send({})
    mockChallenges.get(options.body.challengeId).sessionId = 'another-session'
    expect(
      (
        await request(app)
          .post('/api/v1/webauthn/register-verify')
          .send({
            challengeId: options.body.challengeId,
            response: registration,
          })
      ).status
    ).toBe(400)
    expect(verifyRegistrationResponse).not.toHaveBeenCalled()
  })
  it('supports discoverable login and issues a normal refreshable session once', async () => {
    const app = buildApp()
    credential()
    const body = await login(app)
    const result = await request(app)
      .post('/api/v1/auth/webauthn/login-verify')
      .send(body)
    expect(result.status).toBe(200)
    expect(result.body.refreshToken).toBe('refresh')
    expect(db.session.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: mockUserId,
          walletAddress: mockUser.walletAddress,
          network: 'TESTNET',
          refreshTokenHash: 'hashed-refresh',
          deviceType: expect.any(String),
        }),
      })
    )
    expect(mockCredentials.get(mockCredentialId).signCount).toBe(2n)
    expect(
      (await request(app).post('/api/v1/auth/webauthn/login-verify').send(body))
        .status
    ).toBe(400)
    expect(db.session.create).toHaveBeenCalledTimes(1)
  })
  it('rejects expired challenges before assertion verification', async () => {
    const app = buildApp()
    credential()
    const body = await login(app)
    mockChallenges.get(body.challengeId).expiresAt = new Date(0)
    expect(
      (await request(app).post('/api/v1/auth/webauthn/login-verify').send(body))
        .status
    ).toBe(400)
    expect(verifyAuthenticationResponse).not.toHaveBeenCalled()
  })
  it('rejects a credential belonging to a different requested account', async () => {
    const app = buildApp()
    credential()
    const body = await login(app, mockUserId)
    expect(
      (
        await request(app)
          .post('/api/v1/auth/webauthn/login-verify')
          .send({ ...body, userId: mockCredentialId })
      ).status
    ).toBe(401)
    expect(db.session.create).not.toHaveBeenCalled()
  })
  it.each([0, 1])(
    'rejects a stalled/regressing counter %i and alerts the user',
    async (counter) => {
      const app = buildApp()
      credential()
      const body = await login(app)
      ;(verifyAuthenticationResponse as jest.Mock).mockResolvedValue({
        verified: true,
        authenticationInfo: { newCounter: counter },
      })
      expect(
        (
          await request(app)
            .post('/api/v1/auth/webauthn/login-verify')
            .send(body)
        ).status
      ).toBe(401)
      expect(notifySecurityEvent).toHaveBeenCalledWith(
        mockUserId,
        'passkey.anomaly',
        expect.anything()
      )
      expect(db.session.create).not.toHaveBeenCalled()
    }
  )
  it('alerts when the standards library itself detects a counter anomaly', async () => {
    const app = buildApp()
    credential()
    const body = await login(app)
    ;(verifyAuthenticationResponse as jest.Mock).mockRejectedValue(
      new Error('Response counter value 1 was lower than expected 1')
    )
    expect(
      (await request(app).post('/api/v1/auth/webauthn/login-verify').send(body))
        .status
    ).toBe(401)
    expect(notifySecurityEvent).toHaveBeenCalledWith(
      mockUserId,
      'passkey.anomaly',
      expect.anything()
    )
  })
  it('supports synced authenticators whose counters remain zero', async () => {
    const app = buildApp()
    credential(0n)
    const body = await login(app)
    ;(verifyAuthenticationResponse as jest.Mock).mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 0 },
    })
    expect(
      (await request(app).post('/api/v1/auth/webauthn/login-verify').send(body))
        .status
    ).toBe(200)
  })
  it('preserves enrolled TOTP without issuing a session early', async () => {
    const app = buildApp()
    credential()
    const body = await login(app)
    ;(getActiveTotpCredential as jest.Mock).mockResolvedValue({
      verifiedAt: new Date(),
    })
    const result = await request(app)
      .post('/api/v1/auth/webauthn/login-verify')
      .send(body)
    expect(result.body.requiresTotp).toBe(true)
    expect(result.body.totpChallengeToken).toBe('totp-token')
    expect(db.session.create).not.toHaveBeenCalled()
  })
  it('hides public-key material and enforces credential ownership for deletion', async () => {
    const app = buildApp()
    credential()
    const list = await request(app).get('/api/v1/webauthn/credentials')
    expect(list.body.credentials[0].publicKey).toBeUndefined()
    mockCredentials.get(mockCredentialId).userId = 'other-user'
    expect(
      (
        await request(app).delete(
          `/api/v1/webauthn/credentials/${mockCredentialId}`
        )
      ).status
    ).toBe(404)
    mockCredentials.get(mockCredentialId).userId = mockUserId
    expect(
      (
        await request(app).delete(
          `/api/v1/webauthn/credentials/${mockCredentialId}`
        )
      ).status
    ).toBe(200)
  })
  it('rejects signature/origin verification failures without updating counters', async () => {
    const app = buildApp()
    credential()
    const body = await login(app)
    ;(verifyAuthenticationResponse as jest.Mock).mockRejectedValue(
      new Error('Unexpected authentication response origin')
    )
    expect(
      (await request(app).post('/api/v1/auth/webauthn/login-verify').send(body))
        .status
    ).toBe(401)
    expect(mockCredentials.get(mockCredentialId).signCount).toBe(1n)
    expect(db.session.create).not.toHaveBeenCalled()
  })
})
