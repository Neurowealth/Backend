/**
 * `publishUserEvent` — the one place a user-facing domain event is emitted (#316).
 *
 * Before this existed, every domain site called `dispatchWebhookEvent` directly
 * and a real-time channel would have meant a second bespoke call next to each
 * one, forever out of sync with the first. Now a site publishes once and both
 * channels follow:
 *
 *   1. redact  — project the payload onto its per-type allowlist
 *   2. persist — append to the user's durable stream, allocating `seq`
 *   3. fan out — local sockets + other pods via the Redis bridge
 *   4. webhook — the existing HMAC-signed operator dispatch, unchanged
 *
 * ── Why the webhook leg is unchanged ──────────────────────────────────────────
 * Webhook subscriptions in this codebase are operator-scoped, not user-scoped:
 * `dispatchWebhookEvent` fans out to every active subscription for the event
 * regardless of which user it concerns. So it is called ONCE per domain
 * occurrence even when the occurrence touches many users, and it receives the
 * caller's ORIGINAL payload (including `userId`) — an operator's endpoint is a
 * trusted server and has always needed to know whose event it is. Only the
 * socket leg gets the redacted projection.
 *
 * ── Failure policy ────────────────────────────────────────────────────────────
 * Never throws. Every existing call site treats event emission as
 * fire-and-forget (`dispatchWebhookEvent(...).catch(() => {})`) precisely
 * because a notification problem must not roll back a deposit. That property is
 * preserved here: a store failure is logged, counted, and the webhook leg still
 * runs.
 */

import db from '../db'
import { logger } from '../utils/logger'
import { dispatchWebhookEvent } from '../services/webhookDispatcher'
import { enqueueUserWebhooks } from '../services/userWebhookDispatcher'
import type { WebhookEvent } from '../validators/webhook-validators'
import { mapUserEventPayloadToResponse } from '../utils/api-formatters'
import { recordWsPublishFailure } from '../utils/metrics'
import { appendUserEvent } from './store'
import { broadcastEnvelope, POD_ID } from './bridge'
import {
  hasWebhookCounterpart,
  type UserEventEnvelope,
  type UserEventTopic,
  type UserEventType,
} from './types'

export interface PublishOptions {
  /**
   * Suppress the webhook leg. Only for a site that has already dispatched the
   * webhook for this same occurrence by another route — not a way to make an
   * event "socket-only", which is what SOCKET_ONLY_EVENT_TYPES is for.
   */
  webhook?: boolean
}

/**
 * Resolve who may see this user's events right now.
 *
 * Always the owner, plus any parent holding an ACTIVE sub-account grant with
 * VIEW. Resolved HERE, at publish time, from live rows — not read off the
 * subscriber, and not cached. A grant revoked between two events is absent from
 * the second one's viewer set with nothing to invalidate, which is the whole
 * reason this lives in the publisher rather than in the socket layer.
 */
async function resolveAuthorizedViewers(userId: string): Promise<string[]> {
  try {
    const grants = await db.subAccount.findMany({
      where: {
        childUserId: userId,
        status: 'ACTIVE',
        permissions: { has: 'VIEW' },
      },
      select: { parentUserId: true },
    })
    return [userId, ...grants.map((g) => g.parentUserId)]
  } catch (error) {
    // Fail closed: the owner still gets their own event, a parent does not.
    logger.warn('[PublishUserEvent] Sub-account scope lookup failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return [userId]
  }
}

/**
 * Publish one domain event to one or more users' real-time streams, and — when
 * the type has a webhook counterpart — to the operator webhook channel.
 *
 * @param userId  Stream owner, or several when one occurrence affects several
 *                users (an agent rebalance across a batch). The webhook still
 *                fires exactly once; only the socket streams fan out.
 * @param topic   Subscription/ordering unit. Use EVENT_TYPE_TOPIC[type] unless
 *                you have a specific reason not to.
 * @param type    Domain event type, e.g. 'deposit.received'.
 * @param payload The full domain payload. Redacted per-type for the socket;
 *                passed through verbatim to the webhook dispatcher.
 */
export async function publishUserEvent(
  userId: string | string[],
  topic: UserEventTopic,
  type: UserEventType,
  payload: Record<string, unknown>,
  options: PublishOptions = {}
): Promise<void> {
  const userIds = Array.from(
    new Set(Array.isArray(userId) ? userId : [userId])
  ).filter(Boolean)

  const redacted = mapUserEventPayloadToResponse(type, payload)

  for (const id of userIds) {
    try {
      const stored = await appendUserEvent({
        userId: id,
        topic,
        type,
        payload: redacted,
      })

      const envelope: UserEventEnvelope = {
        streamUserId: id,
        authorizedViewers: await resolveAuthorizedViewers(id),
        seq: stored.seq,
        topic,
        type,
        payload: stored.payload,
        emittedAt: stored.emittedAt,
        originId: POD_ID,
      }

      await broadcastEnvelope(envelope)

      // Enqueue user-scoped webhook deliveries (#368)
      await enqueueUserWebhooks(
        id,
        topic,
        type,
        Number(stored.seq),
        stored.payload as Record<string, any>
      ).catch((err) => {
        logger.warn('[PublishUserEvent] Failed to enqueue user webhooks', {
          userId: id,
          seq: Number(stored.seq),
          error: err instanceof Error ? err.message : String(err),
        })
      })
    } catch (error) {
      // A stream failure must not cost the webhook leg, and must not surface to
      // the caller — see the failure policy in this file's header.
      recordWsPublishFailure()
      logger.error('[PublishUserEvent] Failed to publish to user stream', {
        userId: id,
        topic,
        type,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const wantsWebhook = options.webhook ?? hasWebhookCounterpart(type)
  if (!wantsWebhook) return

  await dispatchWebhookEvent(type as WebhookEvent, payload).catch((error) => {
    logger.warn('[PublishUserEvent] Webhook dispatch failed', {
      type,
      error: error instanceof Error ? error.message : String(error),
    })
  })
}
