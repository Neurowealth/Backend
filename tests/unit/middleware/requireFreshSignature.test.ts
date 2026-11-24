import type { Request, Response, NextFunction } from 'express'
import { Keypair } from '@stellar/stellar-sdk'
import { requireFreshSignature } from '../../../src/middleware/requireFreshSignature'
import { issueStepUpChallenge } from '../../../src/controllers/auth-controller'

const keypair = Keypair.random()
const stellarPubKey = keypair.publicKey()

const storedNonces = new Map<string, { nonce: string; expiresAt: Date }>()

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
  },
}))

describe('requireFreshSignature middleware (#818)', () => {
  let res: Partial<Response>
  let next: NextFunction

  beforeEach(() => {
    storedNonces.clear()
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      locals: {},
    }
    next = jest.fn()
  })

  function signMessage(message: string): string {
    const messageBytes = Buffer.from(message, 'utf8')
    return keypair.sign(messageBytes).toString('base64')
  }

  it('rejects request with 400 when step-up fields are missing', async () => {
    const req = { body: {} } as Request

    await requireFreshSignature('test-purpose')(req, res as Response, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'Step-up authentication fields missing',
      })
    )
  })

  it('rejects request with 401 when nonce is unknown or random', async () => {
    const randomNonce = 'nw-stepup-test-random123456789'
    const signature = signMessage(randomNonce)
    const req = {
      body: {
        stellarPubKey,
        nonce: randomNonce,
        signature,
      },
    } as Request

    await requireFreshSignature('test-purpose')(req, res as Response, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(401)
    expect(res.json).toHaveBeenCalledWith({
      error: 'Step-up authentication failed',
    })
  })

  it('rejects request with 401 when challenge nonce is expired', async () => {
    const expiredChallenge = await issueStepUpChallenge(
      stellarPubKey,
      'test-purpose',
      -1000
    )
    const signature = signMessage(expiredChallenge.nonce)
    const req = {
      body: {
        stellarPubKey,
        nonce: expiredChallenge.nonce,
        signature,
      },
    } as Request

    await requireFreshSignature('test-purpose')(req, res as Response, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(401)
    expect(res.json).toHaveBeenCalledWith({
      error: 'Step-up authentication failed',
    })
  })

  it('verifies and atomically consumes valid nonce, calling next() and setting res.locals.stepUp', async () => {
    const challenge = await issueStepUpChallenge(stellarPubKey, 'test-purpose')
    const signature = signMessage(challenge.nonce)
    const req = {
      body: {
        stellarPubKey,
        nonce: challenge.nonce,
        signature,
      },
    } as Request

    await requireFreshSignature('test-purpose')(req, res as Response, next)

    expect(next).toHaveBeenCalled()
    expect(res.status).not.toHaveBeenCalled()
    expect(res.locals!.stepUp).toEqual({
      stellarPubKey,
      nonce: challenge.nonce,
      verified: true,
    })
  })

  it('rejects a replayed challenge with 401 on the second attempt', async () => {
    const challenge = await issueStepUpChallenge(stellarPubKey, 'test-purpose')
    const signature = signMessage(challenge.nonce)
    const req = {
      body: {
        stellarPubKey,
        nonce: challenge.nonce,
        signature,
      },
    } as Request

    // First attempt succeeds
    await requireFreshSignature('test-purpose')(req, res as Response, next)
    expect(next).toHaveBeenCalled()

    // Second attempt with exact same { nonce, signature } must be rejected with 401
    const next2 = jest.fn()
    const res2: Partial<Response> = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      locals: {},
    }

    await requireFreshSignature('test-purpose')(req, res2 as Response, next2)
    expect(next2).not.toHaveBeenCalled()
    expect(res2.status).toHaveBeenCalledWith(401)
    expect(res2.json).toHaveBeenCalledWith({
      error: 'Step-up authentication failed',
    })
  })
})
