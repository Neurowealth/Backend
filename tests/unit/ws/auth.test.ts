/**
 * #316 — WebSocket handshake authentication and topic scoping.
 *
 * Covers the security-relevant half of the handshake: where a token may come
 * from, that an invalid session is rejected before the protocol switch, and
 * that a delegated (`?actor=`) connection gets the topic set its sub-account
 * grant allows — not the one it asked for.
 */

process.env.NODE_ENV = 'test'
process.env.STELLAR_NETWORK = 'testnet'
process.env.STELLAR_RPC_URL = 'https://soroban-testnet.stellar.org'
process.env.STELLAR_AGENT_SECRET_KEY = 'S' + 'A'.repeat(55)
process.env.VAULT_CONTRACT_ID = 'C' + 'A'.repeat(55)
process.env.USDC_TOKEN_ADDRESS = 'C' + 'B'.repeat(55)
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key'
process.env.DATABASE_URL = 'postgresql://localhost:5432/test'
process.env.JWT_SEED = '0'.repeat(64)
process.env.WALLET_ENCRYPTION_KEY = '0'.repeat(64)
process.env.TWILIO_AUTH_TOKEN = '0'.repeat(32)

import type { IncomingMessage } from 'node:http'
import {
  authenticateHandshake,
  extractActorParam,
  extractHandshakeToken,
} from '../../../src/ws/auth'
import { JwtAdapter } from '../../../src/config'
import db from '../../../src/db'

jest.mock('../../../src/db', () => ({ __esModule: true, default: {} }))
jest.mock('../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

const mockDb = db as any
const CHILD = 'child-1'
const PARENT = 'parent-1'

function req(
  headers: Record<string, string>,
  url = '/api/v1/ws'
): IncomingMessage {
  return { headers, url } as unknown as IncomingMessage
}

function activeSession(userId: string) {
  return {
    id: 'session-1',
    expiresAt: new Date(Date.now() + 60_000),
    user: { id: userId, isActive: true },
  }
}

beforeEach(() => {
  jest
    .spyOn(JwtAdapter, 'validateToken')
    .mockResolvedValue({ id: PARENT } as never)
  mockDb.session = { findUnique: jest.fn() }
  mockDb.subAccount = { findUnique: jest.fn() }
})

describe('extractHandshakeToken', () => {
  it('reads an Authorization bearer header', () => {
    expect(extractHandshakeToken(req({ authorization: 'Bearer tok' }))).toBe(
      'tok'
    )
  })

  it('reads the Sec-WebSocket-Protocol bearer pair browsers must use', () => {
    expect(
      extractHandshakeToken(req({ 'sec-websocket-protocol': 'bearer, tok' }))
    ).toBe('tok')
  })

  it('refuses a token in the query string, where URLs get logged', () => {
    expect(extractHandshakeToken(req({}, '/api/v1/ws?token=tok'))).toBeNull()
  })
})

describe('extractActorParam', () => {
  it('reads ?actor=', () => {
    expect(extractActorParam(req({}, '/api/v1/ws?actor=child-1'))).toBe(
      'child-1'
    )
  })

  it('is null when absent', () => {
    expect(extractActorParam(req({}, '/api/v1/ws'))).toBeNull()
  })
})

describe('authenticateHandshake', () => {
  it('rejects a request with no token', async () => {
    const result = await authenticateHandshake(req({}))
    expect(result).toMatchObject({ ok: false, code: 4401 })
  })

  it('rejects a token with no live session row', async () => {
    mockDb.session.findUnique.mockResolvedValue(null)
    const result = await authenticateHandshake(
      req({ authorization: 'Bearer t' })
    )
    expect(result).toMatchObject({ ok: false, reason: 'unauthorized' })
  })

  it('rejects an expired session even though the JWT still verifies', async () => {
    mockDb.session.findUnique.mockResolvedValue({
      id: 'session-1',
      expiresAt: new Date(Date.now() - 1000),
      user: { id: PARENT, isActive: true },
    })
    const result = await authenticateHandshake(
      req({ authorization: 'Bearer t' })
    )
    expect(result).toMatchObject({ ok: false, reason: 'unauthorized' })
  })

  it('rejects a deactivated account', async () => {
    mockDb.session.findUnique.mockResolvedValue({
      id: 'session-1',
      expiresAt: new Date(Date.now() + 60_000),
      user: { id: PARENT, isActive: false },
    })
    const result = await authenticateHandshake(
      req({ authorization: 'Bearer t' })
    )
    expect(result).toMatchObject({ ok: false, reason: 'unauthorized' })
  })

  it('binds a self connection to every topic', async () => {
    mockDb.session.findUnique.mockResolvedValue(activeSession(PARENT))
    const result = await authenticateHandshake(
      req({ authorization: 'Bearer t' })
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.auth.streamUserId).toBe(PARENT)
    expect(result.auth.delegated).toBe(false)
    expect(result.auth.allowedTopics).toEqual(
      expect.arrayContaining(['portfolio', 'transactions', 'strategies'])
    )
  })

  it('refuses a delegated actor with no grant', async () => {
    mockDb.session.findUnique.mockResolvedValue(activeSession(PARENT))
    mockDb.subAccount.findUnique.mockResolvedValue(null)

    const result = await authenticateHandshake(
      req({ authorization: 'Bearer t' }, `/api/v1/ws?actor=${CHILD}`)
    )
    expect(result).toMatchObject({ ok: false, code: 4403 })
  })

  it('refuses a REVOKED grant', async () => {
    mockDb.session.findUnique.mockResolvedValue(activeSession(PARENT))
    mockDb.subAccount.findUnique.mockResolvedValue({
      permissions: ['VIEW'],
      status: 'REVOKED',
    })

    const result = await authenticateHandshake(
      req({ authorization: 'Bearer t' }, `/api/v1/ws?actor=${CHILD}`)
    )
    expect(result).toMatchObject({ ok: false, code: 4403 })
  })

  it('narrows a VIEW-only parent to the read-only topics', async () => {
    mockDb.session.findUnique.mockResolvedValue(activeSession(PARENT))
    mockDb.subAccount.findUnique.mockResolvedValue({
      permissions: ['VIEW', 'DEPOSIT'],
      status: 'ACTIVE',
    })

    const result = await authenticateHandshake(
      req({ authorization: 'Bearer t' }, `/api/v1/ws?actor=${CHILD}`)
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.auth.delegated).toBe(true)
    expect(result.auth.streamUserId).toBe(CHILD)
    expect(result.auth.viewerUserId).toBe(PARENT)
    expect(result.auth.allowedTopics.sort()).toEqual([
      'agent',
      'alerts',
      'portfolio',
      'transactions',
    ])
    // MANAGE_STRATEGY was not granted, so `strategies` is out of reach.
    expect(result.auth.allowedTopics).not.toContain('strategies')
  })

  it('adds strategies only with MANAGE_STRATEGY', async () => {
    mockDb.session.findUnique.mockResolvedValue(activeSession(PARENT))
    mockDb.subAccount.findUnique.mockResolvedValue({
      permissions: ['VIEW', 'MANAGE_STRATEGY'],
      status: 'ACTIVE',
    })

    const result = await authenticateHandshake(
      req({ authorization: 'Bearer t' }, `/api/v1/ws?actor=${CHILD}`)
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.auth.allowedTopics).toContain('strategies')
  })

  it('treats ?actor= naming yourself as a plain self connection', async () => {
    mockDb.session.findUnique.mockResolvedValue(activeSession(PARENT))

    const result = await authenticateHandshake(
      req({ authorization: 'Bearer t' }, `/api/v1/ws?actor=${PARENT}`)
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.auth.delegated).toBe(false)
    expect(mockDb.subAccount.findUnique).not.toHaveBeenCalled()
  })
})
