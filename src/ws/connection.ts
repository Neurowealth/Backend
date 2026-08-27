/**
 * One authenticated WebSocket connection: subscription state, replay, and
 * backpressure (#316).
 *
 * ── Ordering contract ─────────────────────────────────────────────────────────
 * Within a topic, events are delivered in ascending `seq`. Across topics there
 * is NO ordering guarantee — they share one per-user sequence, so a client that
 * needs a cross-topic order must use `seq` itself, not arrival order. On-chain
 * events inherit ProcessedEvent's ledger ordering upstream of this layer.
 *
 * ── Delivery contract ─────────────────────────────────────────────────────────
 * At-least-once with a duplication window at reconnect: `resume afterSeq`
 * replays from the durable store while live events keep arriving, and the
 * live-switch prefers replaying an event twice over dropping it. Clients dedupe
 * on `seq`, which is monotonic per user.
 *
 * ── Backpressure ──────────────────────────────────────────────────────────────
 * A slow consumer is never queued without bound. Past either bound
 * (WS_MAX_BUFFERED_EVENTS in-process frames, WS_MAX_BUFFERED_BYTES unflushed
 * socket bytes) the connection enters the `gapped` state: it stops delivering,
 * emits one `gap` frame carrying the seq to resume after, and waits. Nothing is
 * lost — the durable stream still holds every event, and the client's next
 * `resume` collects them.
 */

import type { WebSocket } from 'ws'
import { config } from '../config/env'
import { logger } from '../utils/logger'
import {
  recordWsDroppedEvents,
  recordWsGap,
  recordWsMessageReceived,
  recordWsMessageSent,
  recordWsReplay,
} from '../utils/metrics'
import { subscribeToUserStream } from '../events/hub'
import {
  getLatestSeq,
  getOldestAvailableSeq,
  readAfterSeq,
} from '../events/store'
import type {
  ErrorFrame,
  ServerFrame,
  UserEventEnvelope,
  UserEventTopic,
} from '../events/types'
import { clientMessageSchema, type ClientMessage } from './protocol'
import { verifySessionToken, type AuthenticatedHandshake } from './auth'

/** Close codes. 1000/1001 are RFC 6455; 44xx are this application's. */
export const WS_CLOSE = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  UNAUTHORIZED: 4401,
  FORBIDDEN: 4403,
  AUTH_REVOKED: 4408,
  RATE_LIMITED: 4429,
  IDLE_TIMEOUT: 4408,
} as const

type ConnectionState = 'idle' | 'live' | 'replaying' | 'gapped'

interface CoalesceSlot {
  envelope: UserEventEnvelope
  suppressed: number
}

export class StreamConnection {
  private readonly ws: WebSocket
  private readonly auth: AuthenticatedHandshake
  private readonly onClosed: (connection: StreamConnection) => void

  private topics = new Set<UserEventTopic>()
  private state: ConnectionState = 'idle'
  private lastSentSeq = 0
  private coalesce = false
  private closed = false

  /** Live events captured while a replay is in flight, flushed on live-switch. */
  private liveBuffer: UserEventEnvelope[] = []
  /** Latest-wins slots when the client opted into coalescing. */
  private coalesceSlots = new Map<string, CoalesceSlot>()
  private coalesceTimer: NodeJS.Timeout | null = null

  private messageWindowStart = Date.now()
  private messageCount = 0

  private heartbeatTimer: NodeJS.Timeout | null = null
  private sessionTimer: NodeJS.Timeout | null = null
  private lastSeenAt = Date.now()
  private unsubscribeHub: (() => void) | null = null

  constructor(params: {
    ws: WebSocket
    auth: AuthenticatedHandshake
    onClosed: (connection: StreamConnection) => void
  }) {
    this.ws = params.ws
    this.auth = params.auth
    this.onClosed = params.onClosed
  }

  get delegated(): boolean {
    return this.auth.delegated
  }

  get viewerUserId(): string {
    return this.auth.viewerUserId
  }

  get streamUserId(): string {
    return this.auth.streamUserId
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** Wire up listeners, register with the hub, and greet the client. */
  async start(): Promise<void> {
    this.unsubscribeHub = subscribeToUserStream({
      streamUserId: this.auth.streamUserId,
      viewerUserId: this.auth.viewerUserId,
      deliver: (envelope) => this.deliver(envelope),
    })

    this.ws.on('message', (data) => {
      void this.handleMessage(data)
    })
    this.ws.on('pong', () => {
      this.lastSeenAt = Date.now()
    })
    this.ws.on('error', (error) => {
      logger.warn('[WS] Socket error', {
        streamUserId: this.auth.streamUserId,
        error: error instanceof Error ? error.message : String(error),
      })
    })
    this.ws.on('close', () => this.cleanup())

    this.startHeartbeat()
    this.startSessionRecheck()

    const currentSeq = await this.currentSeqSafely()
    this.send({
      type: 'hello',
      actor: this.auth.delegated ? 'delegated' : 'self',
      topics: this.auth.allowedTopics,
      currentSeq,
      heartbeatIntervalMs: config.websocket.heartbeatIntervalMs,
    })
  }

  /**
   * Announce shutdown and close. The client is told the seq to resume after, so
   * a rolling deploy costs a reconnect rather than a REST snapshot.
   */
  drain(): void {
    if (this.closed) return
    this.send({
      type: 'draining',
      reason: 'server_shutdown',
      resumeAfterSeq: this.lastSentSeq,
      retryAfterMs: config.websocket.drainRetryAfterMs,
    })
    this.close(WS_CLOSE.GOING_AWAY, 'Server shutting down')
  }

  close(code: number, reason: string): void {
    if (this.closed) return
    try {
      this.ws.close(code, reason)
    } catch {
      try {
        this.ws.terminate()
      } catch {
        /* socket already gone */
      }
    }
  }

  private cleanup(): void {
    if (this.closed) return
    this.closed = true

    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    if (this.sessionTimer) clearInterval(this.sessionTimer)
    if (this.coalesceTimer) clearTimeout(this.coalesceTimer)
    this.heartbeatTimer = null
    this.sessionTimer = null
    this.coalesceTimer = null

    this.unsubscribeHub?.()
    this.unsubscribeHub = null
    this.liveBuffer = []
    this.coalesceSlots.clear()

    this.onClosed(this)
  }

  // ── Timers ─────────────────────────────────────────────────────────────────

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastSeenAt > config.websocket.idleTimeoutMs) {
        logger.info('[WS] Closing idle connection', {
          streamUserId: this.auth.streamUserId,
        })
        this.close(WS_CLOSE.IDLE_TIMEOUT, 'Idle timeout')
        return
      }
      try {
        this.ws.ping()
      } catch {
        this.close(WS_CLOSE.GOING_AWAY, 'Ping failed')
      }
    }, config.websocket.heartbeatIntervalMs)
  }

  /**
   * A revoked session must kill the live socket, not merely block the next
   * handshake. Polling the session row is the one mechanism that covers every
   * way a session dies — logout, expiry, account deactivation, admin action —
   * without each of those code paths having to know sockets exist.
   */
  private startSessionRecheck(): void {
    this.sessionTimer = setInterval(() => {
      void (async () => {
        try {
          const result = await verifySessionToken(this.auth.token)
          if (!result.ok) {
            logger.info('[WS] Session no longer valid — closing socket', {
              streamUserId: this.auth.streamUserId,
              reason: result.message,
            })
            this.sendError('unauthorized', result.message)
            this.close(WS_CLOSE.AUTH_REVOKED, 'Session revoked')
          }
        } catch (error) {
          // A transient database blip must not disconnect a healthy client.
          logger.warn('[WS] Session recheck failed — keeping connection', {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      })()
    }, config.websocket.sessionRecheckMs)
  }

  // ── Inbound ────────────────────────────────────────────────────────────────

  private async handleMessage(data: unknown): Promise<void> {
    this.lastSeenAt = Date.now()

    if (!this.withinMessageRate()) {
      recordWsMessageReceived('rate_limited')
      this.sendError('rate_limited', 'Message rate limit exceeded')
      this.close(WS_CLOSE.RATE_LIMITED, 'Message rate limit exceeded')
      return
    }

    const raw = Buffer.isBuffer(data) ? data : Buffer.from(String(data))
    if (raw.byteLength > config.websocket.maxMessageBytes) {
      this.sendError('bad_request', 'Message too large')
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw.toString('utf8'))
    } catch {
      recordWsMessageReceived('malformed')
      this.sendError('bad_request', 'Message must be JSON')
      return
    }

    const result = clientMessageSchema.safeParse(parsed)
    if (!result.success) {
      recordWsMessageReceived('invalid')
      this.sendError(
        'bad_request',
        result.error.issues[0]?.message ?? 'Invalid message'
      )
      return
    }

    const message: ClientMessage = result.data
    recordWsMessageReceived(message.type)

    switch (message.type) {
      case 'ping':
        this.send({ type: 'pong', at: new Date().toISOString() })
        return
      case 'subscribe':
        await this.handleSubscribe(message.topics, message.coalesce ?? false)
        return
      case 'resume':
        await this.handleResume(
          message.topics,
          message.afterSeq,
          message.coalesce ?? false
        )
        return
      case 'unsubscribe':
        for (const topic of message.topics) this.topics.delete(topic)
        this.send({
          type: 'subscribed',
          topics: Array.from(this.topics),
          currentSeq: await this.currentSeqSafely(),
          coalesce: this.coalesce,
        })
        return
    }
  }

  private withinMessageRate(): boolean {
    const now = Date.now()
    const { windowMs, max } = config.websocket.messageRateLimit
    if (now - this.messageWindowStart >= windowMs) {
      this.messageWindowStart = now
      this.messageCount = 0
    }
    this.messageCount++
    return this.messageCount <= max
  }

  /**
   * Apply a requested topic set against what the handshake authorised.
   * Returns null after emitting a 'forbidden' error frame — the socket
   * equivalent of the REST 403, and equally non-negotiable: the allowed set
   * came from the sub-account grant, never from the client.
   */
  private applyTopics(requested: UserEventTopic[]): UserEventTopic[] | null {
    const allowed = new Set(this.auth.allowedTopics)
    const denied = requested.filter((topic) => !allowed.has(topic))

    if (denied.length > 0) {
      this.sendError(
        'forbidden',
        `Not permitted to subscribe to: ${denied.join(', ')}`
      )
      return null
    }

    this.topics = new Set(requested)
    return requested
  }

  private async handleSubscribe(
    requested: UserEventTopic[],
    coalesce: boolean
  ): Promise<void> {
    const topics = this.applyTopics(requested)
    if (!topics) return

    this.coalesce = coalesce
    this.state = 'live'

    const currentSeq = await this.currentSeqSafely()
    // A fresh subscribe starts at "now": the client asked for live events, not
    // for history. History is what `resume` is for.
    this.lastSentSeq = currentSeq

    this.send({ type: 'subscribed', topics, currentSeq, coalesce })
  }

  /**
   * Replay everything after `afterSeq`, then switch to live with no gap.
   *
   * Live events arriving during the replay are buffered rather than dropped or
   * sent out of order; the flush skips anything the replay already covered. The
   * remaining risk is a duplicate, never a hole — see the delivery contract.
   */
  private async handleResume(
    requested: UserEventTopic[],
    afterSeq: number,
    coalesce: boolean
  ): Promise<void> {
    const topics = this.applyTopics(requested)
    if (!topics) return

    this.coalesce = coalesce
    this.state = 'replaying'
    this.liveBuffer = []

    let currentSeq = 0
    let oldest: number | null = null
    try {
      currentSeq = await getLatestSeq(this.auth.streamUserId)
      oldest = await getOldestAvailableSeq(this.auth.streamUserId)
    } catch (error) {
      logger.error('[WS] Resume lookup failed', {
        streamUserId: this.auth.streamUserId,
        error: error instanceof Error ? error.message : String(error),
      })
      this.sendError('internal', 'Could not read the event stream')
      this.state = 'live'
      return
    }

    // Ahead of the server: the client's cursor cannot exist here. Treat it as
    // an unknown stream rather than replaying nothing and pretending all is well.
    if (afterSeq > currentSeq) {
      this.emitGap('unknown_stream', afterSeq, currentSeq, oldest, true)
      this.lastSentSeq = currentSeq
      this.finishReplay(topics, currentSeq, coalesce)
      return
    }

    // Behind retention: the cheap path is gone, say so rather than serving a
    // silently truncated replay.
    if (oldest !== null && afterSeq + 1 < oldest) {
      this.emitGap('retention', afterSeq, currentSeq, oldest, true)
      this.lastSentSeq = currentSeq
      this.finishReplay(topics, currentSeq, coalesce)
      return
    }

    let replayed = 0
    let cursor = afterSeq
    try {
      const events = await readAfterSeq({
        userId: this.auth.streamUserId,
        afterSeq,
        topics,
        limit: config.websocket.replayMaxEvents,
      })

      this.send({
        type: 'replay',
        status: 'start',
        fromSeq: afterSeq + 1,
        toSeq: currentSeq,
        count: events.length,
      })

      for (const event of events) {
        this.send({
          type: 'event',
          seq: event.seq,
          topic: event.topic,
          event: event.type,
          payload: event.payload,
          emittedAt: event.emittedAt,
        })
        recordWsMessageSent(event.topic, 'replay')
        cursor = event.seq
        replayed++
      }

      recordWsReplay(replayed)

      this.send({
        type: 'replay',
        status: 'end',
        fromSeq: afterSeq + 1,
        toSeq: cursor,
        count: replayed,
      })
    } catch (error) {
      logger.error('[WS] Replay failed', {
        streamUserId: this.auth.streamUserId,
        error: error instanceof Error ? error.message : String(error),
      })
      this.sendError('internal', 'Replay failed')
      this.state = 'live'
      return
    }

    this.lastSentSeq = cursor

    // The page limit was hit: more history remains. Tell the client to resume
    // again from where we stopped instead of quietly starting the live stream
    // on top of a hole.
    if (replayed === config.websocket.replayMaxEvents && cursor < currentSeq) {
      this.emitGap('retention', cursor, currentSeq, oldest, false)
    }

    this.finishReplay(topics, currentSeq, coalesce)
  }

  /** Flush anything buffered during the replay, then go live. */
  private finishReplay(
    topics: UserEventTopic[],
    currentSeq: number,
    coalesce: boolean
  ): void {
    this.state = 'live'
    const buffered = this.liveBuffer
    this.liveBuffer = []

    for (const envelope of buffered) {
      if (envelope.seq <= this.lastSentSeq) continue
      this.sendEvent(envelope)
    }

    this.send({ type: 'subscribed', topics, currentSeq, coalesce })
  }

  // ── Outbound ───────────────────────────────────────────────────────────────

  /** Hub callback. Authorisation was already decided by the publisher. */
  private deliver(envelope: UserEventEnvelope): void {
    if (this.closed) return
    if (!this.topics.has(envelope.topic)) return

    // Already gapped: the client owes us a `resume`. Counting the drop is the
    // point — silently discarding here is how a "why is my UI stale" bug hides.
    if (this.state === 'gapped') {
      recordWsDroppedEvents('backpressure')
      return
    }

    if (this.state === 'replaying') {
      if (this.liveBuffer.length >= config.websocket.maxBufferedEvents) {
        this.enterGap('backpressure')
        return
      }
      this.liveBuffer.push(envelope)
      return
    }

    if (this.coalesce) {
      this.queueCoalesced(envelope)
      return
    }

    this.sendEvent(envelope)
  }

  /**
   * Latest-wins within a short window, for clients that opted in.
   *
   * A rebalance touching many positions produces a burst of same-type events;
   * a dashboard only ever renders the last one. Suppressed events stay in the
   * durable store, but a later `resume afterSeq` will NOT redeliver them —
   * afterSeq has already moved past them. That is the trade the client made by
   * asking for coalescing, and it is documented in
   * docs/WEBSOCKET_STREAMING.md.
   */
  private queueCoalesced(envelope: UserEventEnvelope): void {
    const key = `${envelope.topic}:${envelope.type}`
    const existing = this.coalesceSlots.get(key)

    if (existing) {
      // Keep the newest; the older one is superseded, not lost from the store.
      const newer =
        envelope.seq > existing.envelope.seq ? envelope : existing.envelope
      this.coalesceSlots.set(key, {
        envelope: newer,
        suppressed: existing.suppressed + 1,
      })
    } else if (this.coalesceSlots.size >= config.websocket.maxBufferedEvents) {
      // More distinct (topic,type) pairs in flight than the buffer allows —
      // the bound applies to coalescing too.
      this.enterGap('backpressure')
      return
    } else {
      this.coalesceSlots.set(key, { envelope, suppressed: 0 })
    }

    if (!this.coalesceTimer) {
      this.coalesceTimer = setTimeout(
        () => this.flushCoalesced(),
        config.websocket.coalesceWindowMs
      )
    }
  }

  private flushCoalesced(): void {
    this.coalesceTimer = null
    const slots = Array.from(this.coalesceSlots.values())
    this.coalesceSlots.clear()

    // Ascending seq: coalescing may drop events, it must never reorder them.
    slots.sort((a, b) => a.envelope.seq - b.envelope.seq)

    for (const slot of slots) {
      if (slot.suppressed > 0) {
        recordWsDroppedEvents('coalesced', slot.suppressed)
      }
      this.sendEvent(slot.envelope)
    }
  }

  private sendEvent(envelope: UserEventEnvelope): void {
    if (this.closed) return

    if (this.ws.bufferedAmount > config.websocket.maxBufferedBytes) {
      this.enterGap('backpressure')
      return
    }

    this.send({
      type: 'event',
      seq: envelope.seq,
      topic: envelope.topic,
      event: envelope.type,
      payload: envelope.payload,
      emittedAt: envelope.emittedAt,
    })
    recordWsMessageSent(envelope.topic, 'live')

    if (envelope.seq > this.lastSentSeq) this.lastSentSeq = envelope.seq
  }

  /**
   * Stop delivering and hand the client a resumable marker.
   * Nothing is lost: the durable stream still has every event past
   * `lastSentSeq`, and the client's `resume` collects them.
   */
  private enterGap(reason: 'backpressure'): void {
    if (this.state === 'gapped') return
    this.state = 'gapped'
    this.liveBuffer = []
    this.coalesceSlots.clear()

    logger.warn('[WS] Connection gapped — slow consumer', {
      streamUserId: this.auth.streamUserId,
      lastSentSeq: this.lastSentSeq,
      bufferedAmount: this.ws.bufferedAmount,
    })

    this.emitGap(reason, this.lastSentSeq, this.lastSentSeq, null, false)
  }

  private emitGap(
    reason: 'retention' | 'backpressure' | 'unknown_stream',
    afterSeq: number | null,
    currentSeq: number,
    oldestAvailableSeq: number | null,
    snapshotRequired: boolean
  ): void {
    recordWsGap(reason)
    this.send({
      type: 'gap',
      reason,
      afterSeq,
      currentSeq,
      oldestAvailableSeq,
      snapshotRequired,
    })
  }

  private sendError(code: ErrorFrame['code'], message: string): void {
    this.send({ type: 'error', code, message })
  }

  private send(frame: ServerFrame): void {
    if (this.closed) return
    try {
      this.ws.send(JSON.stringify(frame))
    } catch (error) {
      logger.warn('[WS] Frame send failed', {
        streamUserId: this.auth.streamUserId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async currentSeqSafely(): Promise<number> {
    try {
      return await getLatestSeq(this.auth.streamUserId)
    } catch (error) {
      logger.warn('[WS] Could not read current seq', {
        streamUserId: this.auth.streamUserId,
        error: error instanceof Error ? error.message : String(error),
      })
      return this.lastSentSeq
    }
  }
}
