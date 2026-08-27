/**
 * #316 — per-connection backpressure and coalescing.
 *
 * Driven against a fake socket rather than a real one so `bufferedAmount` can
 * be forced past the bound on demand — the whole point of the backpressure
 * path is what happens when the kernel buffer is full, which is not something a
 * loopback socket in a unit test will do for you.
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
process.env.WS_COALESCE_WINDOW_MS = '20'

import type { WebSocket } from 'ws'
import { StreamConnection } from '../../../src/ws/connection'
import { deliverToLocalSubscribers, resetHub } from '../../../src/events/hub'
import { getLatestSeq } from '../../../src/events/store'
import type { UserEventEnvelope } from '../../../src/events/types'
import type { AuthenticatedHandshake } from '../../../src/ws/auth'

jest.mock('../../../src/db', () => ({ __esModule: true, default: {} }))
jest.mock('../../../src/events/store', () => ({
  getLatestSeq: jest.fn().mockResolvedValue(0),
  getOldestAvailableSeq: jest.fn().mockResolvedValue(null),
  readAfterSeq: jest.fn().mockResolvedValue([]),
}))
jest.mock('../../../src/ws/auth', () => ({
  verifySessionToken: jest.fn().mockResolvedValue({
    ok: true,
    userId: 'user-1',
    sessionId: 'session-1',
  }),
}))
jest.mock('../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

const USER = 'user-1'

const auth: AuthenticatedHandshake = {
  viewerUserId: USER,
  streamUserId: USER,
  sessionId: 'session-1',
  token: 'token',
  allowedTopics: ['portfolio', 'transactions', 'agent', 'alerts', 'strategies'],
  delegated: false,
}

/** Minimal WebSocket stand-in: records frames, exposes a settable buffer size. */
class FakeSocket {
  readonly sent: any[] = []
  bufferedAmount = 0
  private handlers = new Map<string, (...args: any[]) => void>()

  on(event: string, handler: (...args: any[]) => void): this {
    this.handlers.set(event, handler)
    return this
  }
  send(raw: string): void {
    this.sent.push(JSON.parse(raw))
  }
  ping(): void {}
  close(): void {
    this.handlers.get('close')?.()
  }
  terminate(): void {}
  emit(event: string, ...args: any[]): void {
    this.handlers.get(event)?.(...args)
  }
  framesOfType(type: string): any[] {
    return this.sent.filter((f) => f.type === type)
  }
}

function envelope(seq: number, type = 'portfolio.updated'): UserEventEnvelope {
  return {
    streamUserId: USER,
    authorizedViewers: [USER],
    seq,
    topic: 'portfolio',
    type: type as UserEventEnvelope['type'],
    payload: { reason: 'rebalance' },
    emittedAt: '2026-08-25T00:00:00.000Z',
    originId: 'pod-1',
  }
}

/** Connections opened by a test, closed in afterEach so no timer outlives it. */
const opened: StreamConnection[] = []

async function connected(
  socket: FakeSocket,
  message: Record<string, unknown> = {
    type: 'subscribe',
    topics: ['portfolio'],
  }
): Promise<StreamConnection> {
  const connection = new StreamConnection({
    ws: socket as unknown as WebSocket,
    auth,
    onClosed: () => {},
  })
  opened.push(connection)
  await connection.start()
  socket.emit('message', Buffer.from(JSON.stringify(message)))
  // Let the async subscribe handler settle before events are delivered.
  await new Promise((resolve) => setImmediate(resolve))
  return connection
}

afterEach(() => {
  for (const connection of opened.splice(0)) connection.close(1000, 'test over')
  resetHub()
  jest.clearAllMocks()
  ;(getLatestSeq as jest.Mock).mockResolvedValue(0)
})

describe('StreamConnection backpressure', () => {
  it('delivers normally while the socket keeps up', async () => {
    const socket = new FakeSocket()
    await connected(socket)

    deliverToLocalSubscribers(envelope(1))
    deliverToLocalSubscribers(envelope(2))

    expect(socket.framesOfType('event').map((f) => f.seq)).toEqual([1, 2])
    expect(socket.framesOfType('gap')).toHaveLength(0)
  })

  it('gaps with a resumable marker instead of buffering for a slow consumer', async () => {
    const socket = new FakeSocket()
    await connected(socket)

    deliverToLocalSubscribers(envelope(1))
    socket.bufferedAmount = 999_999_999 // kernel buffer full
    deliverToLocalSubscribers(envelope(2))

    const gap = socket.framesOfType('gap')
    expect(gap).toHaveLength(1)
    expect(gap[0]).toMatchObject({
      reason: 'backpressure',
      // The client resumes from the last frame it actually got.
      afterSeq: 1,
    })
    expect(socket.framesOfType('event').map((f) => f.seq)).toEqual([1])
  })

  it('emits exactly one gap frame however long the consumer stays behind', async () => {
    const socket = new FakeSocket()
    await connected(socket)

    socket.bufferedAmount = 999_999_999
    for (let seq = 1; seq <= 25; seq++) {
      deliverToLocalSubscribers(envelope(seq))
    }

    expect(socket.framesOfType('gap')).toHaveLength(1)
    expect(socket.framesOfType('event')).toHaveLength(0)
  })

  it('coalesces same-type bursts to the newest when the client opts in', async () => {
    const socket = new FakeSocket()
    await connected(socket, {
      type: 'subscribe',
      topics: ['portfolio'],
      coalesce: true,
    })

    for (let seq = 1; seq <= 5; seq++) {
      deliverToLocalSubscribers(envelope(seq))
    }

    // Nothing sent yet — the window is still open.
    expect(socket.framesOfType('event')).toHaveLength(0)

    await new Promise((resolve) => setTimeout(resolve, 60))

    const events = socket.framesOfType('event')
    expect(events).toHaveLength(1)
    expect(events[0].seq).toBe(5)
  })

  it('keeps distinct event types separate while coalescing', async () => {
    const socket = new FakeSocket()
    await connected(socket, {
      type: 'subscribe',
      topics: ['portfolio'],
      coalesce: true,
    })

    deliverToLocalSubscribers(envelope(1, 'portfolio.updated'))
    deliverToLocalSubscribers(envelope(2, 'portfolio.updated'))
    deliverToLocalSubscribers(envelope(3, 'transaction.confirmed'))

    await new Promise((resolve) => setTimeout(resolve, 60))

    // Latest-wins per (topic, type), emitted in ascending seq.
    expect(socket.framesOfType('event').map((f) => f.seq)).toEqual([2, 3])
  })

  it('does not coalesce unless the client asked for it', async () => {
    const socket = new FakeSocket()
    await connected(socket)

    for (let seq = 1; seq <= 4; seq++) {
      deliverToLocalSubscribers(envelope(seq))
    }

    expect(socket.framesOfType('event').map((f) => f.seq)).toEqual([1, 2, 3, 4])
  })
})

describe('StreamConnection message handling', () => {
  it('rejects a frame larger than the configured cap', async () => {
    const socket = new FakeSocket()
    await connected(socket)

    socket.emit('message', Buffer.alloc(10_000, 'a'))

    expect(socket.framesOfType('error')[0]).toMatchObject({
      code: 'bad_request',
      message: 'Message too large',
    })
  })

  it('answers an application ping with a pong', async () => {
    const socket = new FakeSocket()
    await connected(socket)

    socket.emit('message', Buffer.from(JSON.stringify({ type: 'ping' })))

    expect(socket.framesOfType('pong')).toHaveLength(1)
  })

  it('stops delivering a topic after unsubscribe', async () => {
    const socket = new FakeSocket()
    const connection = await connected(socket)

    socket.emit(
      'message',
      Buffer.from(
        JSON.stringify({ type: 'unsubscribe', topics: ['portfolio'] })
      )
    )
    await new Promise((resolve) => setImmediate(resolve))

    deliverToLocalSubscribers(envelope(1))
    expect(socket.framesOfType('event')).toHaveLength(0)
    connection.close(1000, 'done')
  })
})
