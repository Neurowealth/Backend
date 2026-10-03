/**
 * Guardian recovery ROUTE tests (#535).
 *
 * Scope is deliberately narrow: the service's security properties are covered
 * in tests/unit/guardians/service.test.ts. What is tested here is the property
 * that belongs to the HTTP layer and cannot be enforced anywhere else --
 *
 *   `POST /recovery/initiate` must be INDISTINGUISHABLE across every outcome.
 *
 * It is the only endpoint a locked-out claimant can reach, it takes an
 * arbitrary wallet address, and it opens a real recovery. If the response
 * varies at all between "no such wallet", "sub-account", "no guardians" and
 * "recovery opened", then this endpoint is a wallet-existence oracle worth
 * more to an attacker than the recovery itself, and every other control in the
 * feature becomes decoration. These tests assert byte-identical responses.
 */

process.env.NODE_ENV = 'test'

import express from 'express'
import request from 'supertest'
import recoveryRouter from '../../../src/routes/recovery'

jest.mock('../../../src/guardians/service', () => {
  const actual = jest.requireActual('../../../src/guardians/service')
  return {
    ...actual,
    // Every public entry point is mocked so the ROUTE's response shaping can be
    // asserted independently of what the service decides.
    initiateRecovery: jest.fn(),
    cancelRecovery: jest.fn(),
    nominateGuardian: jest.fn(),
    listGuardians: jest.fn(),
    getOrCreateRecoveryPolicy: jest.fn(),
    updateRecoveryPolicy: jest.fn(),
    getRecoveryRequestForOwner: jest.fn(),
    acceptGuardianInviteAsUser: jest.fn(),
    respondToGuardianInvite: jest.fn(),
    removeGuardian: jest.fn(),
    approveRecoveryAsGuardian: jest.fn(),
    approveRecoveryAsExternalGuardian: jest.fn(),
    listRequestsAwaitingGuardian: jest.fn(),
  }
})

jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: {},
}))

jest.mock('../../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}))

// The real limiter is shared across the process and would 429 the later tests
// once the earlier ones spend its budget. Its presence is asserted separately
// from the router stack, so passthrough-ing it here does not weaken the test.
jest.mock('../../../src/middleware/rateLimiter', () => ({
  recoveryRateLimiter: (_req: any, _res: any, next: any) => next(),
}))

// requireAuth is exercised as "denied unless a header is present"; the tests
// here are about the unauthenticated surface.
jest.mock('../../../src/middleware/authenticate', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    if (!req.headers?.authorization) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
    req.auth = { userId: 'user-1', sessionId: 's1' }
    next()
  },
}))

const service = require('../../../src/guardians/service')

const app = express()
app.use(express.json())
app.use('/recovery', recoveryRouter)

const VALID_WALLET = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'

describe('POST /recovery/initiate — anti-enumeration', () => {
  beforeEach(() => jest.clearAllMocks())

  it.each([
    [
      'a recovery was opened',
      { request: { id: 'r1' }, acceptedGuardians: 3, requiredApprovals: 2 },
    ],
    [
      'no such wallet exists',
      { request: null, acceptedGuardians: 0, requiredApprovals: 0 },
    ],
    [
      'the wallet is a sub-account',
      { request: null, acceptedGuardians: 2, requiredApprovals: 2 },
    ],
    [
      'there are not enough guardians',
      { request: null, acceptedGuardians: 1, requiredApprovals: 2 },
    ],
  ])('answers 202 with an identical body when %s', async (_label, outcome) => {
    service.initiateRecovery.mockResolvedValue(outcome)

    const res = await request(app)
      .post('/recovery/initiate')
      .send({ walletAddress: VALID_WALLET, reason: 'Lost my device' })

    expect(res.status).toBe(202)
    expect(res.body).toEqual({
      status: 'accepted',
      message:
        'If an eligible primary account matches that wallet address, its accepted guardians have been contacted and the account owner has been alerted.',
    })
  })

  it('never echoes back whether the recovery actually opened', async () => {
    service.initiateRecovery.mockResolvedValue({
      request: { id: 'secret-request-id' },
      acceptedGuardians: 3,
      requiredApprovals: 2,
    })

    const res = await request(app)
      .post('/recovery/initiate')
      .send({ walletAddress: VALID_WALLET, reason: 'Lost my device' })

    expect(JSON.stringify(res.body)).not.toContain('secret-request-id')
    expect(res.body).not.toHaveProperty('request')
    expect(res.body).not.toHaveProperty('acceptedGuardians')
    expect(res.body).not.toHaveProperty('requiredApprovals')
  })

  it('gives the same 202 even when the service throws', async () => {
    // A fault must not distinguish itself from success, or the error rate becomes
    // the oracle: "it 500s for real wallets" leaks exactly what a 200 would.
    service.initiateRecovery.mockRejectedValue(new Error('db exploded'))

    const res = await request(app)
      .post('/recovery/initiate')
      .send({ walletAddress: VALID_WALLET, reason: 'Lost my device' })

    expect(res.status).toBe(202)
    expect(res.body.status).toBe('accepted')
  })

  it('is byte-identical across every outcome', async () => {
    const bodies: string[] = []
    const statuses: number[] = []

    const outcomes: any[] = [
      { request: { id: 'r1' }, acceptedGuardians: 3, requiredApprovals: 2 },
      { request: null, acceptedGuardians: 0, requiredApprovals: 0 },
      new Error('boom'),
    ]

    for (const outcome of outcomes) {
      if (outcome instanceof Error) {
        service.initiateRecovery.mockRejectedValue(outcome)
      } else {
        service.initiateRecovery.mockResolvedValue(outcome)
      }
      const res = await request(app)
        .post('/recovery/initiate')
        .send({ walletAddress: VALID_WALLET, reason: 'Lost my device' })
      bodies.push(JSON.stringify(res.body))
      statuses.push(res.status)
    }

    expect(new Set(bodies).size).toBe(1)
    expect(new Set(statuses).size).toBe(1)
  })

  it('rejects a malformed body with 400 rather than a generic 202', async () => {
    // Validation failure is about the CALLER's request shape, not about the
    // wallet, so it is safe (and useful) to be specific here.
    const res = await request(app)
      .post('/recovery/initiate')
      .send({ walletAddress: '', reason: '' })

    expect(res.status).toBe(400)
  })
})

describe('guardian decision endpoints', () => {
  beforeEach(() => jest.clearAllMocks())

  it('requires auth for a platform guardian decision', async () => {
    await request(app)
      .post('/recovery/guardian/requests/abc/decide')
      .send({ approved: true })
      .expect(401)
  })

  it('requires auth to cancel', async () => {
    await request(app).post('/recovery/requests/abc/cancel').expect(401)
  })

  it('accepts an external guardian decision without a session', async () => {
    service.approveRecoveryAsExternalGuardian.mockResolvedValue({
      id: 'r1',
      status: 'PENDING',
    })

    const res = await request(app).post('/recovery/guardian/decide').send({
      requestId: '5a7b2f1e-8c3d-4e5f-9a0b-1c2d3e4f5a6b',
      token: 'a-token',
      approved: true,
    })

    expect(res.status).toBe(200)
    expect(service.approveRecoveryAsExternalGuardian).toHaveBeenCalled()
  })

  it('exposes no endpoint that executes a recovery', () => {
    // Execution is platform-side only (the sweeper). A public execute route
    // would be callable only by the very session it is about to revoke.
    const paths = (recoveryRouter as any).stack.map(
      (layer: any) => layer.route?.path
    )
    const flat = paths.filter(Boolean).join(' ')
    expect(flat).not.toMatch(/execute/i)
  })

  it('rate limits the public endpoints but not the authenticated ones', () => {
    // /initiate triggers real email and WhatsApp to third-party guardians, so
    // leaving it unthrottled is an email-bombing primitive aimed at a bystander.
    const withLimiter = (path: string): boolean =>
      (recoveryRouter as any).stack.some(
        (layer: any) =>
          layer.route?.path === path &&
          layer.route.stack.some((l: any) => l.name === 'recoveryRateLimiter')
      )

    expect(withLimiter('/initiate')).toBe(true)
    expect(withLimiter('/invitations/respond')).toBe(true)
    expect(withLimiter('/guardian/decide')).toBe(true)

    // Owner endpoints sit behind the caller's own session.
    expect(withLimiter('/policy')).toBe(false)
    expect(withLimiter('/requests/:requestId/cancel')).toBe(false)
  })
})
