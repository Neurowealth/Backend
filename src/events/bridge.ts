/**
 * Redis pub/sub bridge for multi-instance delivery (#316).
 *
 * When the API runs on more than one pod, a user's socket lives on exactly one
 * of them while the event that concerns them may be produced on any. Every
 * publish is therefore broadcast on a single Redis channel; each pod delivers
 * it to whichever of that user's connections it happens to hold.
 *
 * ── Loss window, stated plainly ───────────────────────────────────────────────
 * Redis pub/sub is fire-and-forget: an envelope published while a pod is
 * restarting, partitioned, or slow is simply not delivered to that pod's
 * sockets. So live delivery is AT-MOST-ONCE across pods.
 *
 * The durable store closes that window, not the transport. Every envelope was
 * already committed to `user_events` with its seq before it reached this
 * module, so a client that reconnects and sends `resume afterSeq` gets whatever
 * it missed, in order. The contract the client sees is therefore at-least-once
 * with possible duplicates around a reconnect — which is why every frame
 * carries `seq` and clients dedupe on it.
 *
 * ── When Redis is down or unconfigured ────────────────────────────────────────
 * The publish is never dropped silently. It always reaches this pod's own
 * subscribers first (bounded in-process broadcast), the failure is counted on
 * `ws_bridge_publish_total{outcome="local_only"|"error"}`, and an alert is
 * raised through alertingService with a stable dedupe key so an hour-long
 * outage produces one alert rather than one per event.
 */

import { randomUUID } from 'crypto'
import type { Redis } from 'ioredis'
import { createRedisSubscriber, getRedisClient } from '../config/redis'
import { logger } from '../utils/logger'
import { alertingService } from '../services/alerting'
import { recordWsBridgePublish } from '../utils/metrics'
import { deliverToLocalSubscribers } from './hub'
import { isUserEventTopic, type UserEventEnvelope } from './types'

const CHANNEL = process.env.WS_EVENT_CHANNEL || 'neurowealth:user-events'

/**
 * Identifies this process in every envelope so we can drop the Redis echo of
 * our own publish — the local fan-out already happened synchronously.
 */
export const POD_ID = `${process.env.HOSTNAME || 'pod'}-${randomUUID().slice(0, 8)}`

let subscriber: Redis | null = null
let started = false

/** Parse and validate an envelope off the wire. Returns null if unusable. */
function parseEnvelope(raw: string): UserEventEnvelope | null {
  try {
    const parsed = JSON.parse(raw) as UserEventEnvelope
    if (
      typeof parsed?.streamUserId !== 'string' ||
      typeof parsed?.seq !== 'number' ||
      !Array.isArray(parsed?.authorizedViewers) ||
      !isUserEventTopic(parsed?.topic)
    ) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

/**
 * Start listening for envelopes published by other pods.
 * No-op (and logged once) when REDIS_URL is unset — single-pod deployments and
 * the test suite run entirely on the in-process hub.
 */
export async function startEventBridge(): Promise<void> {
  if (started) return
  started = true

  subscriber = createRedisSubscriber()
  if (!subscriber) {
    logger.warn(
      '[EventBridge] REDIS_URL not set — cross-pod event delivery disabled. ' +
        'Single-instance deployments are unaffected; horizontally scaled ones ' +
        'will only deliver events to sockets on the publishing pod.'
    )
    return
  }

  subscriber.on('message', (channel, raw) => {
    if (channel !== CHANNEL) return

    const envelope = parseEnvelope(raw)
    if (!envelope) {
      logger.warn('[EventBridge] Discarded unparseable envelope')
      return
    }

    // Our own publish already fanned out locally; redelivering it here would
    // hand every local socket a duplicate of every event.
    if (envelope.originId === POD_ID) return

    deliverToLocalSubscribers(envelope)
  })

  await subscriber.subscribe(CHANNEL)
  logger.info(`[EventBridge] Subscribed to ${CHANNEL} as ${POD_ID}`)
}

/**
 * Fan an envelope out: local subscribers synchronously, other pods via Redis.
 * Returns the number of local deliveries.
 */
export async function broadcastEnvelope(
  envelope: UserEventEnvelope
): Promise<number> {
  const localDeliveries = deliverToLocalSubscribers(envelope)

  const redis = getRedisClient()
  if (!redis) {
    recordWsBridgePublish('local_only')
    return localDeliveries
  }

  try {
    await redis.publish(CHANNEL, JSON.stringify(envelope))
    recordWsBridgePublish('redis')
  } catch (error) {
    recordWsBridgePublish('error')
    logger.error(
      '[EventBridge] Redis publish failed — delivered locally only',
      {
        streamUserId: envelope.streamUserId,
        seq: envelope.seq,
        error: error instanceof Error ? error.message : String(error),
      }
    )

    // Stable dedupe key: one alert per outage, not one per event.
    alertingService
      .emit(
        {
          title: 'Real-time event bridge degraded',
          description:
            'Redis publish failed, so events are reaching only the sockets on ' +
            'the publishing pod. Clients on other pods will see the gap closed ' +
            'by their next `resume afterSeq`, but live latency is broken until ' +
            'Redis recovers.',
          severity: 'warning',
          component: 'event-bridge',
          metadata: { channel: CHANNEL, podId: POD_ID },
        },
        'ws:bridge:redis-publish-failed'
      )
      .catch(() => {})
  }

  return localDeliveries
}

/** Close the subscriber connection. Safe to call when never started. */
export async function stopEventBridge(): Promise<void> {
  started = false
  if (!subscriber) return
  try {
    await subscriber.unsubscribe(CHANNEL)
    await subscriber.quit()
  } catch (error) {
    logger.warn('[EventBridge] Subscriber shutdown error', {
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    subscriber = null
  }
}
