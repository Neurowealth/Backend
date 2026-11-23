process.env.NODE_ENV = 'test'
process.env.JWT_SEED = '0'.repeat(64)

import express from 'express'
import request from 'supertest'
import { Keypair } from '@stellar/stellar-sdk'
import sessionsRouter from '../../../src/routes/sessions'
import {
  issueStepUpChallenge,
  verifyAndConsumeStepUpChallenge,
} from '../../../src/controllers/auth-controller'

const keypair = Keypair.random()
const stellarPubKey = keypair.publicKey()
const testUserId = 'user-stepup-1'
const testSessionId = 'session-1'

// Mock database state for AuthNonce, User, TotpCredential, Session
let storedNonces = new Map<string, { nonce: string; expiresAt: Date }>()
let activeTotpCredential: { userId: string; verifiedAt: Date | null } | null = {
  userId: testUserId,
  verifiedAt: new Date(),
}

jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: {
    authNonce: {
      upsert: jest.fn().mockImplementation(({ where, update, create }) => {
        const val = create || update
        storedNonces.set(where.stellarPubKey, {
          nonce: val.nonce,
          expiresAt: val.expiresAt,
        })
        return Promise.resolve({ stellarPubKey: where.stellarPubKey, ...val })
      }),
      findUnique: jest.fn().mockImplementation(({ where }) => {
        const row = storedNonces.get(where.stellarPubKey)
        if (!row) return Promise.resolve(null)
        return Promise.resolve({ stellarPubKey: where.stellarPubKey, ...row })
      }),
      delete: jest.fn().mockImplementation(({ where }) => {
        const exists = storedNonces.has(where.stellarPubKey)
        if (!exists)
          return Promise.reject(new Error('Record to delete does not exist'))
        storedNonces.delete(where.stellarPubKey)
        return Promise.resolve({ stellarPubKey: where.stellarPubKey })
      }),
    },
    user: {
      findUnique: jest.fn().mockImplementation(({ where }) => {
        if (where.id === testUserId || where.walletAddress === stellarPubKey) {
          return Promise.resolve({
            id: testUserId,
            walletAddress: stellarPubKey,
            network: 'TESTNET',
            isActive: true,
          })
        }
        return Promise.resolve(null)
      }),
    },
    totpCredential: {
      findUnique: jest.fn().mockImplementation(({ where }) => {
        if (where.userId === testUserId && activeTotpCredential) {
          return Promise.resolve(activeTotpCredential)
        }
        return Promise.resolve(null)
      }),
      delete: jest.fn().mockImplementation(({ where }) => {
        if (where.userId === testUserId) {
          activeTotpCredential = null
          return Promise.resolve({ userId: testUserId })
        }
        return Promise.reject(new Error('Not found'))
      }),
    },
    session: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          { id: 'session-2', deviceType: 'mobile', approxLocation: 'London' },
        ]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({ id: 'session-2' }),
    },
    userDataAudit: {
      create: jest.fn().mockResolvedValue({ id: 'audit-1' }),
    },
  },
}))

jest.mock('../../../src/middleware/authenticate', () => {
  const actual = jest.requireActual('../../../src/middleware/authenticate')
  return {
    ...actual,
    requireAuth: (req: any, _res: any, next: any) => {
      req.userId = testUserId
      req.stellarPubKey = stellarPubKey
      req.authKind = 'session'
      req.auth = {
        userId: testUserId,
        sessionId: testSessionId,
        walletAddress: stellarPubKey,
        network: 'TESTNET',
      }
      next()
    },
  }
})

describe('Step-up Signature Nonce Protection and Anti-Replay (#761)', () => {
  let app: express.Application

  beforeEach(() => {
    storedNonces.clear()
    activeTotpCredential = {
      userId: testUserId,
      verifiedAt: new Date(),
    }
    app = express()
    app.use(express.json())
    app.use('/api/v1/sessions', sessionsRouter)
  })

  function signMessage(message: string): string {
    const messageBytes = Buffer.from(message, 'utf8')
    return keypair.sign(messageBytes).toString('base64')
  }

  describe('POST /api/v1/sessions/2fa/disable', () => {
    it('succeeds once with a fresh purpose-bound challenge', async () => {
      const challenge = await issueStepUpChallenge(stellarPubKey, '2fa:disable')
      const signature = signMessage(challenge.nonce)

      const res = await request(app).post('/api/v1/sessions/2fa/disable').send({
        stellarPubKey,
        nonce: challenge.nonce,
        signature,
      })

      expect(res.status).toBe(200)
      expect(res.body.status).toBe('disabled')
    })

    it('rejects a replayed challenge with 401 on the second attempt', async () => {
      const challenge = await issueStepUpChallenge(stellarPubKey, '2fa:disable')
      const signature = signMessage(challenge.nonce)

      // First attempt succeeds
      const firstRes = await request(app)
        .post('/api/v1/sessions/2fa/disable')
        .send({
          stellarPubKey,
          nonce: challenge.nonce,
          signature,
        })
      expect(firstRes.status).toBe(200)

      // Re-arm TOTP to verify rejection is due to nonce replay, not missing credential
      activeTotpCredential = { userId: testUserId, verifiedAt: new Date() }

      // Second attempt with exact same { nonce, signature } must fail with 401
      const replayRes = await request(app)
        .post('/api/v1/sessions/2fa/disable')
        .send({
          stellarPubKey,
          nonce: challenge.nonce,
          signature,
        })

      expect(replayRes.status).toBe(401)
      expect(replayRes.body.error).toBe('Step-up authentication failed')
    })

    it('rejects an unknown or tampered nonce with 401', async () => {
      await issueStepUpChallenge(stellarPubKey, '2fa:disable')
      const unknownNonce = 'nw-stepup-2fa:disable-randomfake123456789'
      const signature = signMessage(unknownNonce)

      const res = await request(app).post('/api/v1/sessions/2fa/disable').send({
        stellarPubKey,
        nonce: unknownNonce,
        signature,
      })

      expect(res.status).toBe(401)
      expect(res.body.error).toBe('Step-up authentication failed')
    })

    it('rejects an expired challenge nonce with 401', async () => {
      // Issue challenge with negative TTL so it is already expired
      const expiredChallenge = await issueStepUpChallenge(
        stellarPubKey,
        '2fa:disable',
        -1000
      )
      const signature = signMessage(expiredChallenge.nonce)

      const res = await request(app).post('/api/v1/sessions/2fa/disable').send({
        stellarPubKey,
        nonce: expiredChallenge.nonce,
        signature,
      })

      expect(res.status).toBe(401)
      expect(res.body.error).toBe('Step-up authentication failed')
    })

    it('rejects a captured login challenge (nw-auth) replayed for step-up', async () => {
      // Create login nonce in authNonce table
      const loginNonce = `nw-auth-${'a'.repeat(64)}`
      storedNonces.set(stellarPubKey, {
        nonce: loginNonce,
        expiresAt: new Date(Date.now() + 60000),
      })
      const signature = signMessage(loginNonce)

      const res = await request(app).post('/api/v1/sessions/2fa/disable').send({
        stellarPubKey,
        nonce: loginNonce,
        signature,
      })

      expect(res.status).toBe(401)
      expect(res.body.error).toBe('Step-up authentication failed')
    })
  })

  describe('POST /api/v1/sessions/revoke-others', () => {
    it('succeeds once with a fresh purpose-bound challenge', async () => {
      const challenge = await issueStepUpChallenge(
        stellarPubKey,
        'sessions:revoke-others'
      )
      const signature = signMessage(challenge.nonce)

      const res = await request(app)
        .post('/api/v1/sessions/revoke-others')
        .send({
          stellarPubKey,
          nonce: challenge.nonce,
          signature,
        })

      expect(res.status).toBe(200)
    })

    it('rejects replay with 401 on the second attempt', async () => {
      const challenge = await issueStepUpChallenge(
        stellarPubKey,
        'sessions:revoke-others'
      )
      const signature = signMessage(challenge.nonce)

      // First attempt succeeds
      const firstRes = await request(app)
        .post('/api/v1/sessions/revoke-others')
        .send({
          stellarPubKey,
          nonce: challenge.nonce,
          signature,
        })
      expect(firstRes.status).toBe(200)

      // Second attempt with exact same { nonce, signature } must fail with 401
      const replayRes = await request(app)
        .post('/api/v1/sessions/revoke-others')
        .send({
          stellarPubKey,
          nonce: challenge.nonce,
          signature,
        })

      expect(replayRes.status).toBe(401)
      expect(replayRes.body.error).toBe('Step-up authentication failed')
    })

    it('rejects request missing step-up signature fields via requireFreshSignature with 400', async () => {
      const res = await request(app)
        .post('/api/v1/sessions/revoke-others')
        .send({
          stellarPubKey,
          // Missing nonce and signature
        })

      expect(res.status).toBe(400)
      expect(res.body.error).toContain('Step-up authentication fields missing')
    })
  })
})
