/**
 * In-process fan-out registry for live WebSocket subscribers (#316).
 *
 * Deliberately knows nothing about `ws`, JWTs, or Prisma: it maps a stream
 * owner's id to a set of callbacks. That keeps the publisher independent of the
 * transport (the socket layer registers here; so could an SSE layer later) and
 * keeps the socket layer's tests free of a Redis or database dependency.
 *
 * Authorisation is NOT decided here. The envelope arrives with the viewer set
 * the publisher resolved; a subscriber is handed the event only if the identity
 * it authenticated at handshake is in that set. See UserEventEnvelope.
 */

import { logger } from '../utils/logger'
import type { UserEventEnvelope } from './types'

export interface HubSubscriber {
  /** Stream this subscriber is bound to (own userId, or a permitted child's). */
  streamUserId: string
  /** Identity that authenticated at handshake — matched against the viewer set. */
  viewerUserId: string
  deliver: (envelope: UserEventEnvelope) => void
}

const subscribersByStream = new Map<string, Set<HubSubscriber>>()

/** Register a subscriber. Returns the unregister function. */
export function subscribeToUserStream(subscriber: HubSubscriber): () => void {
  let set = subscribersByStream.get(subscriber.streamUserId)
  if (!set) {
    set = new Set()
    subscribersByStream.set(subscriber.streamUserId, set)
  }
  set.add(subscriber)

  return () => {
    const current = subscribersByStream.get(subscriber.streamUserId)
    if (!current) return
    current.delete(subscriber)
    if (current.size === 0) subscribersByStream.delete(subscriber.streamUserId)
  }
}

/**
 * Deliver an envelope to every local subscriber of its stream that the
 * publisher authorised.
 *
 * A throwing subscriber is logged and skipped: one wedged socket must never
 * stop the fan-out to the others.
 */
export function deliverToLocalSubscribers(envelope: UserEventEnvelope): number {
  const set = subscribersByStream.get(envelope.streamUserId)
  if (!set || set.size === 0) return 0

  const authorized = new Set(envelope.authorizedViewers)
  let delivered = 0

  for (const subscriber of set) {
    if (!authorized.has(subscriber.viewerUserId)) continue
    try {
      subscriber.deliver(envelope)
      delivered++
    } catch (error) {
      logger.warn('[EventHub] Subscriber delivery threw — skipping', {
        streamUserId: envelope.streamUserId,
        seq: envelope.seq,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return delivered
}

/** Every subscriber currently bound to a stream (used to close revoked sockets). */
export function getLocalSubscribers(streamUserId: string): HubSubscriber[] {
  return Array.from(subscribersByStream.get(streamUserId) ?? [])
}

/** Total live subscribers — the source for the ws_connections_active gauge. */
export function countLocalSubscribers(): number {
  let total = 0
  for (const set of subscribersByStream.values()) total += set.size
  return total
}

/** Test helper: forget every registration. */
export function resetHub(): void {
  subscribersByStream.clear()
}
