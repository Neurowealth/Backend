import { EventEmitter } from 'node:events'
import { handleSseConnection } from '../../../src/sse/handler'
import {
  publishToHub,
  countLocalSubscribers,
  resetHub,
} from '../../../src/events/hub'
import db from '../../../src/db'

jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: {},
}))

jest.mock('../../../src/utils/logger', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
  },
}))

jest.mock('../../../src/middleware/streamAuth', () => ({
  authenticateStreamRequest: jest.fn().mockResolvedValue({
    ok: true,
    viewerUserId: 'user-1',
    streamUserId: 'user-1',
    allowedTopics: ['transfers', 'trades'],
  }),
}))

const mockDb = db as any

describe('SSE Handler lifecycle and gap-free replay', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    resetHub()
    mockDb.userEvent = {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    }
  })

  afterEach(() => {
    resetHub()
  })

  it('cleans up timers and subscriptions on client disconnect during replay', async () => {
    jest.useFakeTimers()

    const req: any = new EventEmitter()
    req.headers = { 'last-event-id': '10' }
    req.query = { topics: 'transfers' }

    const res: any = {
      setHeader: jest.fn(),
      flushHeaders: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
      destroyed: false,
      writableEnded: false,
      writableLength: 0,
    }

    let resolveReplayQuery: (val: any) => void
    const replayPromise = new Promise((resolve) => {
      resolveReplayQuery = resolve
    })

    mockDb.userEvent.findMany.mockImplementation(async () => {
      // While replay is in flight, client disconnects
      req.emit('close')
      res.destroyed = true
      return replayPromise
    })

    const handlerPromise = handleSseConnection(req, res)

    // Verify subscriber was registered initially
    expect(countLocalSubscribers()).toBe(0) // Immediately cleaned up when req emitted close

    // Resolve the in-flight replay query
    resolveReplayQuery!([])
    await handlerPromise

    // Assert countLocalSubscribers back to 0
    expect(countLocalSubscribers()).toBe(0)

    // Assert no timers (e.g. heartbeat) left running
    expect(jest.getTimerCount()).toBe(0)

    jest.useRealTimers()
  })

  it('buffers events published mid-replay and delivers each event exactly once (deduped by seq)', async () => {
    const req: any = new EventEmitter()
    req.headers = { 'last-event-id': '10' }
    req.query = { topics: 'transfers' }

    const writes: string[] = []
    const res: any = {
      setHeader: jest.fn(),
      flushHeaders: jest.fn(),
      write: jest.fn((chunk: string) => {
        writes.push(chunk)
        return true
      }),
      end: jest.fn(),
      destroyed: false,
      writableEnded: false,
      writableLength: 0,
    }

    let resolveReplay: (events: any[]) => void
    const replayDeferred = new Promise<any[]>((resolve) => {
      resolveReplay = resolve
    })

    mockDb.userEvent.findMany.mockImplementation(async () => {
      // Mid-replay: hub receives an envelope that overlaps with replay (seq 11)
      // and a new live envelope (seq 12)
      publishToHub({
        streamUserId: 'user-1',
        viewerUserId: 'user-1',
        seq: 11,
        topic: 'transfers',
        type: 'transfer.created',
        payload: { id: 't-1' },
      })

      publishToHub({
        streamUserId: 'user-1',
        viewerUserId: 'user-1',
        seq: 12,
        topic: 'transfers',
        type: 'transfer.settled',
        payload: { id: 't-2' },
      })

      return replayDeferred
    })

    const handlerPromise = handleSseConnection(req, res)

    // Hub subscription was established before replay
    expect(countLocalSubscribers()).toBe(1)

    // Replay returns retained event seq 11
    resolveReplay!([
      {
        seq: BigInt(11),
        type: 'transfer.created',
        topic: 'transfers',
        payload: { id: 't-1' },
      },
    ])

    await handlerPromise

    // Inspect event delivery chunks
    const seq11Writes = writes.filter((w) => w.includes('id: 11'))
    const seq12Writes = writes.filter((w) => w.includes('id: 12'))

    // Assert seq 11 delivered exactly once (deduped between replay and live buffer)
    expect(seq11Writes.length).toBe(1)
    expect(seq11Writes[0]).toContain('event: transfer.created')

    // Assert seq 12 delivered from live buffer
    expect(seq12Writes.length).toBe(1)
    expect(seq12Writes[0]).toContain('event: transfer.settled')

    // Disconnect and assert cleanup
    req.emit('close')
    expect(countLocalSubscribers()).toBe(0)
  })
})
