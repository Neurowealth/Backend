/**
 * Shared vocabulary for the authenticated real-time stream (#316).
 *
 * Every user-facing domain event flows through `publishUserEvent` (see
 * ./publisher.ts) and lands in exactly one topic. Topics are the unit of
 * subscription, of ordering, and of permission — keep them coarse.
 */

import type { WebhookEvent } from '../validators/webhook-validators'

// ── Topics ────────────────────────────────────────────────────────────────────

export const USER_EVENT_TOPICS = [
  'portfolio',
  'transactions',
  'agent',
  'alerts',
  'strategies',
] as const

export type UserEventTopic = (typeof USER_EVENT_TOPICS)[number]

export function isUserEventTopic(value: unknown): value is UserEventTopic {
  return (
    typeof value === 'string' &&
    (USER_EVENT_TOPICS as readonly string[]).includes(value)
  )
}

// ── Event types ───────────────────────────────────────────────────────────────

/**
 * Socket-only event types — real-time signals with no webhook counterpart.
 * Kept deliberately separate from WEBHOOK_EVENTS so adding one here can never
 * change what an operator's configured webhook receives.
 */
export const SOCKET_ONLY_EVENT_TYPES = [
  /** Emitted alongside agent.rebalanced: this user's positions moved. */
  'portfolio.updated',
  /** #374 — API key lifecycle notifications. */
  'security.api_key_changed',
  /** #376 — new session sign-in alert. */
  'security.new_session',
] as const

export type SocketOnlyEventType = (typeof SOCKET_ONLY_EVENT_TYPES)[number]

/** Anything publishable on a user stream: a webhook event or a socket-only one. */
export type UserEventType = WebhookEvent | SocketOnlyEventType

/**
 * Canonical topic for every event type. Exhaustive over both unions, so a new
 * webhook event fails the build here until someone decides where it belongs —
 * which is the whole point of routing through one table rather than wiring each
 * emit site by hand.
 */
export const EVENT_TYPE_TOPIC: Record<UserEventType, UserEventTopic> = {
  'transaction.confirmed': 'transactions',
  'deposit.received': 'transactions',
  'withdraw.completed': 'transactions',
  'fiat.order.settled': 'transactions',
  'fiat.order.failed': 'transactions',
  'fiat.order.rate_mismatch': 'transactions',
  'recurring_deposit.executed': 'transactions',
  'recurring_deposit.failed': 'transactions',
  'outbox.op_failed': 'transactions',
  // #314 — a PENDING_APPROVAL operation's lifecycle is itself a transaction
  // state (gating a withdraw/deposit before it submits), so it shares the
  // 'transactions' topic rather than introducing a new one.
  'approval.requested': 'transactions',
  'approval.approved': 'transactions',
  'approval.rejected': 'transactions',
  'approval.executed': 'transactions',
  'approval.expired': 'transactions',
  'approval.cancelled': 'transactions',
  'agent.rebalanced': 'agent',
  'alert_rule.triggered': 'alerts',
  'strategy.updated': 'strategies',
  'strategy.unpublished': 'strategies',
  'portfolio.updated': 'portfolio',
  'security.api_key_changed': 'alerts',
  'security.new_session': 'alerts',
}

const SOCKET_ONLY = new Set<string>(SOCKET_ONLY_EVENT_TYPES)

/** True when this type also has an operator-facing webhook counterpart. */
export function hasWebhookCounterpart(type: UserEventType): boolean {
  return !SOCKET_ONLY.has(type)
}

// ── Wire frames (server → client) ─────────────────────────────────────────────

/** One delivered domain event. `seq` is monotonic within the user's stream. */
export interface EventFrame {
  type: 'event'
  seq: number
  topic: UserEventTopic
  event: UserEventType
  payload: Record<string, unknown>
  emittedAt: string
}

/**
 * Sent instead of a replay the server cannot honour, and after a
 * backpressure drop. `snapshotRequired` tells the client the cheap path
 * (replay) is gone and it should re-fetch a REST snapshot before resubscribing.
 */
export interface GapFrame {
  type: 'gap'
  reason: 'retention' | 'backpressure' | 'unknown_stream'
  /** The seq the client asked to resume after, when it asked. */
  afterSeq: number | null
  /** Newest seq that exists for this user right now. */
  currentSeq: number
  /** Oldest seq still replayable, or null when the stream is empty. */
  oldestAvailableSeq: number | null
  snapshotRequired: boolean
}

export interface SubscribedFrame {
  type: 'subscribed'
  topics: UserEventTopic[]
  currentSeq: number
  /** Echoed so a client can confirm the server honoured its coalesce request. */
  coalesce: boolean
}

export interface ReplayFrame {
  type: 'replay'
  status: 'start' | 'end'
  fromSeq: number
  toSeq: number
  count: number
}

export interface ErrorFrame {
  type: 'error'
  code:
    'bad_request' | 'forbidden' | 'unauthorized' | 'rate_limited' | 'internal'
  message: string
}

/** Sent before the socket closes during graceful shutdown. */
export interface DrainingFrame {
  type: 'draining'
  reason: 'server_shutdown'
  /** Resume from here on the next connection. */
  resumeAfterSeq: number
  retryAfterMs: number
}

/** Reply to an application-level `ping`. */
export interface PongFrame {
  type: 'pong'
  at: string
}

export interface HelloFrame {
  type: 'hello'
  /** The stream this connection is bound to: self, or a permitted child. */
  actor: 'self' | 'delegated'
  topics: UserEventTopic[]
  currentSeq: number
  heartbeatIntervalMs: number
}

export type ServerFrame =
  | HelloFrame
  | SubscribedFrame
  | ReplayFrame
  | EventFrame
  | GapFrame
  | ErrorFrame
  | DrainingFrame
  | PongFrame

// ── Internal envelope (publisher → fan-out, including across pods) ────────────

/**
 * What travels from `publishUserEvent` to every connection holder, locally and
 * over the Redis bridge.
 *
 * `authorizedViewers` is resolved by the PUBLISHER, from the live SubAccount
 * grants, at the moment of publish. The socket layer only ever intersects it
 * with the viewer identity it authenticated at handshake — it never re-derives
 * permission and never trusts anything the subscriber said. A grant revoked a
 * second ago is therefore absent from the next event's viewer set without any
 * cache to invalidate.
 */
export interface UserEventEnvelope {
  streamUserId: string
  authorizedViewers: string[]
  seq: number
  topic: UserEventTopic
  type: UserEventType
  /** Already redacted — see mapUserEventPayloadToResponse. */
  payload: Record<string, unknown>
  emittedAt: string
  /** Pod that published it; used to suppress the Redis echo of our own emit. */
  originId: string
}
