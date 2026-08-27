/**
 * #316 — end-to-end WebSocket streaming, driven by a real socket client.
 *
 * A real `ws` client connects to a real WebSocketServer attached to a real HTTP
 * server, and drives the full sequence the acceptance criteria name:
 *
 *     handshake → subscribe → live event → disconnect → resume replay → gap
 *
 * Only Postgres is substituted, by an in-memory store that implements the exact
 * queries src/events/store.ts and src/ws/auth.ts issue. Everything else runs
 * for real: the JWT is genuinely signed and verified, the handshake genuinely
 * looks up a session, the publisher genuinely redacts, allocates a seq, and
 * fans out through the hub, and the connection genuinely replays from the
 * store. Mocking the socket layer would leave the interesting half untested.
 */

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import WebSocket from 'ws'

// ── In-memory Postgres substitute ─────────────────────────────────────────────
//
// Declared before the src imports because jest.mock is hoisted above them.

interface StoredRow {
  userId: string
  seq: number
  topic: string
  type: string
  payload: Record<string, unknown>
  createdAt: Date
}

const CHILD_USER = 'child-user-1'
const PARENT_USER = 'parent-user-1'
const OTHER_USER = 'other-user-1'

const store = {
  rows: [] as StoredRow[],
  seqs: new Map<string, number>(),
  sessions: new Map<
    string,
    { userId: string; isActive: boolean; expiresAt: Date }
  >(),
  grants: new Map<string, { permissions: string[]; status: string }>(),
  reset(): void {
    store.rows = []
    store.seqs.clear()
    store.sessions.clear()
    store.grants.clear()
  },
}

const mockDb: any = {
  $transaction: async (fn: (tx: any) => Promise<unknown>) => fn(mockDb),
  // src/events/store.ts allocates the seq with a tagged-template
  // INSERT … ON CONFLICT DO UPDATE … RETURNING. values[0] is the userId.
  $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    const userId = values[0] as string
    const next = (store.seqs.get(userId) ?? 0) + 1
    store.seqs.set(userId, next)
    return [{ lastSeq: BigInt(next) }]
  },
  userEvent: {
    create: async ({ data }: any) => {
      const row: StoredRow = { ...data, createdAt: new Date() }
      store.rows.push(row)
      return row
    },
    findMany: async ({ where, take }: any) => {
      const topics: string[] = where.topic?.in ?? []
      return store.rows
        .filter(
          (r) =>
            r.userId === where.userId &&
            r.seq > where.seq.gt &&
            (topics.length === 0 || topics.includes(r.topic))
        )
        .sort((a, b) => a.seq - b.seq)
        .slice(0, take)
    },
    findFirst: async ({ where }: any) => {
      const matching = store.rows
        .filter((r) => r.userId === where.userId)
        .sort((a, b) => a.seq - b.seq)
      return matching[0] ?? null
    },
    deleteMany: async () => ({ count: 0 }),
  },
  userEventSequence: {
    findUnique: async ({ where }: any) => {
      const last = store.seqs.get(where.userId)
      return last === undefined ? null : { lastSeq: BigInt(last) }
    },
  },
  session: {
    findUnique: async ({ where }: any) => {
      const session = store.sessions.get(where.token)
      if (!session) return null
      return {
        id: `session-${session.userId}`,
        userId: session.userId,
        expiresAt: session.expiresAt,
        user: { id: session.userId, isActive: session.isActive },
      }
    },
  },
  subAccount: {
    findUnique: async ({ where }: any) => {
      const { parentUserId, childUserId } = where.parentUserId_childUserId
      return store.grants.get(`${parentUserId}:${childUserId}`) ?? null
    },
    findMany: async ({ where }: any) => {
      const parents: Array<{ parentUserId: string }> = []
      for (const [key, grant] of store.grants) {
        const [parentUserId, childUserId] = key.split(':')
        if (
          childUserId === where.childUserId &&
          grant.status === 'ACTIVE' &&
          grant.permissions.includes('VIEW')
        ) {
          parents.push({ parentUserId })
        }
      }
      return parents
    },
  },
  webhookSubscription: { findMany: async () => [] },
}

jest.mock('../../src/db', () => ({ __esModule: true, default: mockDb }))
jest.mock('../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  logBackgroundJob: jest.fn(),
}))

import { JwtAdapter } from '../../src/config'
import { config } from '../../src/config/env'
import { publishUserEvent } from '../../src/events/publisher'
import { resetHub } from '../../src/events/hub'
import {
  attachWebSocketServer,
  closeWebSocketServer,
  getConnectionCount,
} from '../../src/ws/server'

// ── Harness ───────────────────────────────────────────────────────────────────

let server: http.Server
let port: number

/** Collects frames so a test can await the one it cares about. */
class FrameCollector {
  readonly frames: any[] = []
  constructor(private readonly ws: WebSocket) {
    ws.on('message', (raw) => this.frames.push(JSON.parse(raw.toString())))
  }

  /** Resolve once a frame matching `predicate` arrives (or has already). */
  async waitFor(
    predicate: (frame: any) => boolean,
    timeoutMs = 3000
  ): Promise<any> {
    const existing = this.frames.find(predicate)
    if (existing) return existing

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ws.off('message', onMessage)
        reject(
          new Error(
            `Timed out waiting for frame. Saw: ${JSON.stringify(
              this.frames.map((f) => f.type)
            )}`
          )
        )
      }, timeoutMs)

      const onMessage = (raw: WebSocket.RawData) => {
        const frame = JSON.parse(raw.toString())
        if (!predicate(frame)) return
        clearTimeout(timer)
        this.ws.off('message', onMessage)
        resolve(frame)
      }

      this.ws.on('message', onMessage)
    })
  }
}

async function issueToken(userId: string): Promise<string> {
  const token = (await JwtAdapter.generateToken({ id: userId }))!
  store.sessions.set(token, {
    userId,
    isActive: true,
    expiresAt: new Date(Date.now() + 3_600_000),
  })
  return token
}

function connect(
  token: string | null,
  query = ''
): { ws: WebSocket; frames: FrameCollector } {
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}${config.websocket.path}${query}`,
    { headers }
  )
  return { ws, frames: new FrameCollector(ws) }
}

function open(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
}

const sockets: WebSocket[] = []

function track(ws: WebSocket): WebSocket {
  sockets.push(ws)
  return ws
}

beforeAll(async () => {
  server = http.createServer()
  attachWebSocketServer(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await closeWebSocketServer(500)
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  store.reset()
})

afterEach(async () => {
  for (const ws of sockets.splice(0)) {
    ws.removeAllListeners()
    ws.terminate()
  }
  // Give the server's close handlers a tick to deregister the connections.
  await new Promise((resolve) => setTimeout(resolve, 20))
  resetHub()
})

// ── Handshake ─────────────────────────────────────────────────────────────────

describe('WebSocket handshake', () => {
  it('rejects an unauthenticated upgrade with 401 before any data is sent', async () => {
    const { ws } = connect(null)
    track(ws)

    const error = await new Promise<Error>((resolve) =>
      ws.once('error', resolve)
    )
    expect(error.message).toMatch(/401/)
    expect(getConnectionCount()).toBe(0)
  })

  it('rejects a token whose session was revoked', async () => {
    const token = await issueToken(CHILD_USER)
    store.sessions.delete(token) // logout between issuing and connecting

    const { ws } = connect(token)
    track(ws)

    const error = await new Promise<Error>((resolve) =>
      ws.once('error', resolve)
    )
    expect(error.message).toMatch(/401/)
  })

  it('accepts an authenticated upgrade and greets with hello', async () => {
    const token = await issueToken(CHILD_USER)
    const { ws, frames } = connect(token)
    track(ws)
    await open(ws)

    const hello = await frames.waitFor((f) => f.type === 'hello')
    expect(hello).toMatchObject({ actor: 'self', currentSeq: 0 })
    expect(hello.topics).toEqual(
      expect.arrayContaining(['portfolio', 'transactions', 'strategies'])
    )
  })
})

// ── Subscribe and live delivery ───────────────────────────────────────────────

describe('subscribe and live delivery', () => {
  it('delivers a published event to a subscribed client, redacted', async () => {
    const token = await issueToken(CHILD_USER)
    const { ws, frames } = connect(token)
    track(ws)
    await open(ws)
    await frames.waitFor((f) => f.type === 'hello')

    ws.send(JSON.stringify({ type: 'subscribe', topics: ['transactions'] }))
    await frames.waitFor((f) => f.type === 'subscribed')

    await publishUserEvent(CHILD_USER, 'transactions', 'deposit.received', {
      txHash: 'tx-1',
      amount: '25',
      assetSymbol: 'USDC',
      protocolName: 'Blend',
      network: 'testnet',
      user: 'GWALLET',
      userId: CHILD_USER,
    })

    const event = await frames.waitFor((f) => f.type === 'event')
    expect(event).toMatchObject({
      seq: 1,
      topic: 'transactions',
      event: 'deposit.received',
    })
    expect(event.payload).toMatchObject({ txHash: 'tx-1', amount: '25' })
    // The wire must not carry identity just because it is a socket.
    expect(event.payload).not.toHaveProperty('userId')
    expect(event.payload).not.toHaveProperty('user')
  })

  it('does not deliver another user’s events', async () => {
    const token = await issueToken(CHILD_USER)
    const { ws, frames } = connect(token)
    track(ws)
    await open(ws)
    await frames.waitFor((f) => f.type === 'hello')
    ws.send(JSON.stringify({ type: 'subscribe', topics: ['transactions'] }))
    await frames.waitFor((f) => f.type === 'subscribed')

    await publishUserEvent(OTHER_USER, 'transactions', 'deposit.received', {
      txHash: 'tx-other',
    })
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(frames.frames.filter((f) => f.type === 'event')).toHaveLength(0)
  })

  it('withholds events on topics the client did not subscribe to', async () => {
    const token = await issueToken(CHILD_USER)
    const { ws, frames } = connect(token)
    track(ws)
    await open(ws)
    await frames.waitFor((f) => f.type === 'hello')
    ws.send(JSON.stringify({ type: 'subscribe', topics: ['alerts'] }))
    await frames.waitFor((f) => f.type === 'subscribed')

    await publishUserEvent(CHILD_USER, 'transactions', 'deposit.received', {
      txHash: 'tx-1',
    })
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(frames.frames.filter((f) => f.type === 'event')).toHaveLength(0)
  })

  it('answers a malformed message with an error frame, not a disconnect', async () => {
    const token = await issueToken(CHILD_USER)
    const { ws, frames } = connect(token)
    track(ws)
    await open(ws)
    await frames.waitFor((f) => f.type === 'hello')

    ws.send('not json')
    const error = await frames.waitFor((f) => f.type === 'error')
    expect(error.code).toBe('bad_request')
    expect(ws.readyState).toBe(WebSocket.OPEN)
  })
})

// ── Resume and replay ─────────────────────────────────────────────────────────

describe('resume replay', () => {
  it('replays everything missed while disconnected, in order, then goes live', async () => {
    const token = await issueToken(CHILD_USER)

    // Three events happen while the client is away.
    for (const txHash of ['tx-1', 'tx-2', 'tx-3']) {
      await publishUserEvent(CHILD_USER, 'transactions', 'deposit.received', {
        txHash,
      })
    }

    const { ws, frames } = connect(token)
    track(ws)
    await open(ws)
    await frames.waitFor((f) => f.type === 'hello')

    ws.send(
      JSON.stringify({
        type: 'resume',
        topics: ['transactions'],
        afterSeq: 1, // the client already processed tx-1
      })
    )

    await frames.waitFor((f) => f.type === 'replay' && f.status === 'end')

    const replayed = frames.frames.filter((f) => f.type === 'event')
    expect(replayed.map((f) => f.seq)).toEqual([2, 3])
    expect(replayed.map((f) => f.payload.txHash)).toEqual(['tx-2', 'tx-3'])

    // …and the switch to live leaves no hole.
    await publishUserEvent(CHILD_USER, 'transactions', 'deposit.received', {
      txHash: 'tx-4',
    })
    const live = await frames.waitFor((f) => f.type === 'event' && f.seq === 4)
    expect(live.payload.txHash).toBe('tx-4')
  })

  it('replays nothing when the client is already current', async () => {
    const token = await issueToken(CHILD_USER)
    await publishUserEvent(CHILD_USER, 'transactions', 'deposit.received', {
      txHash: 'tx-1',
    })

    const { ws, frames } = connect(token)
    track(ws)
    await open(ws)
    await frames.waitFor((f) => f.type === 'hello')

    ws.send(
      JSON.stringify({
        type: 'resume',
        topics: ['transactions'],
        afterSeq: 1,
      })
    )

    const end = await frames.waitFor(
      (f) => f.type === 'replay' && f.status === 'end'
    )
    expect(end.count).toBe(0)
    expect(frames.frames.filter((f) => f.type === 'event')).toHaveLength(0)
  })

  it('restricts a replay to the requested topics', async () => {
    const token = await issueToken(CHILD_USER)
    await publishUserEvent(CHILD_USER, 'transactions', 'deposit.received', {
      txHash: 'tx-1',
    })
    await publishUserEvent(CHILD_USER, 'alerts', 'alert_rule.triggered', {
      ruleId: 'rule-1',
    })

    const { ws, frames } = connect(token)
    track(ws)
    await open(ws)
    await frames.waitFor((f) => f.type === 'hello')

    ws.send(JSON.stringify({ type: 'resume', topics: ['alerts'], afterSeq: 0 }))
    await frames.waitFor((f) => f.type === 'replay' && f.status === 'end')

    const events = frames.frames.filter((f) => f.type === 'event')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ seq: 2, topic: 'alerts' })
  })
})

// ── Gap semantics ─────────────────────────────────────────────────────────────

describe('gap frames', () => {
  it('answers a stale afterSeq with a gap carrying the newest available seq', async () => {
    const token = await issueToken(CHILD_USER)

    // Simulate retention having evicted seq 1–5: the counter is at 8, but the
    // oldest surviving row is 6.
    store.seqs.set(CHILD_USER, 8)
    for (const seq of [6, 7, 8]) {
      store.rows.push({
        userId: CHILD_USER,
        seq,
        topic: 'transactions',
        type: 'deposit.received',
        payload: { txHash: `tx-${seq}` },
        createdAt: new Date(),
      })
    }

    const { ws, frames } = connect(token)
    track(ws)
    await open(ws)
    await frames.waitFor((f) => f.type === 'hello')

    ws.send(
      JSON.stringify({
        type: 'resume',
        topics: ['transactions'],
        afterSeq: 2, // older than what survives
      })
    )

    const gap = await frames.waitFor((f) => f.type === 'gap')
    expect(gap).toMatchObject({
      reason: 'retention',
      afterSeq: 2,
      currentSeq: 8,
      oldestAvailableSeq: 6,
      snapshotRequired: true,
    })
    // No truncated replay was served alongside it.
    expect(frames.frames.filter((f) => f.type === 'event')).toHaveLength(0)
  })

  it('answers an afterSeq ahead of the server with an unknown_stream gap', async () => {
    const token = await issueToken(CHILD_USER)
    const { ws, frames } = connect(token)
    track(ws)
    await open(ws)
    await frames.waitFor((f) => f.type === 'hello')

    ws.send(
      JSON.stringify({
        type: 'resume',
        topics: ['transactions'],
        afterSeq: 99,
      })
    )

    const gap = await frames.waitFor((f) => f.type === 'gap')
    expect(gap).toMatchObject({
      reason: 'unknown_stream',
      currentSeq: 0,
      snapshotRequired: true,
    })
  })
})

// ── Sub-account scoping ───────────────────────────────────────────────────────

describe('sub-account delegated streams', () => {
  it('delivers a child’s events to a permitted parent', async () => {
    const parentToken = await issueToken(PARENT_USER)
    store.grants.set(`${PARENT_USER}:${CHILD_USER}`, {
      permissions: ['VIEW'],
      status: 'ACTIVE',
    })

    const { ws, frames } = connect(parentToken, `?actor=${CHILD_USER}`)
    track(ws)
    await open(ws)

    const hello = await frames.waitFor((f) => f.type === 'hello')
    expect(hello.actor).toBe('delegated')

    ws.send(JSON.stringify({ type: 'subscribe', topics: ['transactions'] }))
    await frames.waitFor((f) => f.type === 'subscribed')

    await publishUserEvent(CHILD_USER, 'transactions', 'deposit.received', {
      txHash: 'tx-child',
    })

    const event = await frames.waitFor((f) => f.type === 'event')
    expect(event.payload.txHash).toBe('tx-child')
  })

  it('rejects a delegated handshake with no grant', async () => {
    const parentToken = await issueToken(PARENT_USER)
    const { ws } = connect(parentToken, `?actor=${CHILD_USER}`)
    track(ws)

    const error = await new Promise<Error>((resolve) =>
      ws.once('error', resolve)
    )
    expect(error.message).toMatch(/403/)
  })

  it('refuses a topic outside the grant with a forbidden error frame', async () => {
    const parentToken = await issueToken(PARENT_USER)
    store.grants.set(`${PARENT_USER}:${CHILD_USER}`, {
      permissions: ['VIEW'], // no MANAGE_STRATEGY
      status: 'ACTIVE',
    })

    const { ws, frames } = connect(parentToken, `?actor=${CHILD_USER}`)
    track(ws)
    await open(ws)
    await frames.waitFor((f) => f.type === 'hello')

    ws.send(JSON.stringify({ type: 'subscribe', topics: ['strategies'] }))

    const error = await frames.waitFor((f) => f.type === 'error')
    expect(error).toMatchObject({ code: 'forbidden' })
    expect(error.message).toMatch(/strategies/)
  })

  it('stops delivering the moment the grant is revoked, without a reconnect', async () => {
    const parentToken = await issueToken(PARENT_USER)
    store.grants.set(`${PARENT_USER}:${CHILD_USER}`, {
      permissions: ['VIEW'],
      status: 'ACTIVE',
    })

    const { ws, frames } = connect(parentToken, `?actor=${CHILD_USER}`)
    track(ws)
    await open(ws)
    await frames.waitFor((f) => f.type === 'hello')
    ws.send(JSON.stringify({ type: 'subscribe', topics: ['transactions'] }))
    await frames.waitFor((f) => f.type === 'subscribed')

    // Revoked after the handshake — the publisher re-resolves viewers per event,
    // so the very next publish is already out of reach.
    store.grants.set(`${PARENT_USER}:${CHILD_USER}`, {
      permissions: ['VIEW'],
      status: 'REVOKED',
    })

    await publishUserEvent(CHILD_USER, 'transactions', 'deposit.received', {
      txHash: 'tx-after-revoke',
    })
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(frames.frames.filter((f) => f.type === 'event')).toHaveLength(0)
  })
})

// ── Graceful shutdown ─────────────────────────────────────────────────────────

describe('graceful shutdown', () => {
  it('sends a draining frame with a resumable seq before closing', async () => {
    const token = await issueToken(CHILD_USER)
    const { ws, frames } = connect(token)
    track(ws)
    await open(ws)
    await frames.waitFor((f) => f.type === 'hello')
    ws.send(JSON.stringify({ type: 'subscribe', topics: ['transactions'] }))
    await frames.waitFor((f) => f.type === 'subscribed')

    await publishUserEvent(CHILD_USER, 'transactions', 'deposit.received', {
      txHash: 'tx-1',
    })
    await frames.waitFor((f) => f.type === 'event')

    const closed = new Promise<number>((resolve) =>
      ws.once('close', (code) => resolve(code))
    )

    await closeWebSocketServer(500)

    const draining = await frames.waitFor((f) => f.type === 'draining')
    expect(draining).toMatchObject({
      reason: 'server_shutdown',
      resumeAfterSeq: 1,
    })
    expect(await closed).toBe(1001)

    // Re-attach for the remaining tests in the file.
    attachWebSocketServer(server)
  })
})
