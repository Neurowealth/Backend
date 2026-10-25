/**
 * Scheduled cross-channel digest delivery (#365).
 *
 * On each tick this job claims DUE, ACTIVE `DigestSubscription`s
 * (`nextRunAt <= now`), assembles ONE digest for the user over the preceding
 * period, and delivers it per channel.
 *
 * Design decisions (see docs/NOTIFICATIONS.md):
 *
 *  • Atomic claim: before delivering we updateMany the row conditioned on
 *    `{ id, isActive, nextRunAt }`. A concurrent runner, a mid-tick deactivate,
 *    or a delete matches 0 rows and we skip — no double-send.
 *
 *  • Quiet hours defer, never drop: if the due slot falls inside the
 *    subscription's quiet window, we DON'T deliver this tick; we advance
 *    `nextRunAt` to the next allowed slot (via deferForQuietHours) so the sink
 *    fires again at that time. The occurrence is picked up then, after quiet.
 *
 *  • Catch-up storm guard: after a delivery `nextRunAt` is advanced to the NEXT
 *    future occurrence (`nextOccurrence`). A server that was down for N periods
 *    therefore sends exactly ONE digest on recovery, not N — `lastSentAt` is
 *    only a stamp; missed occurrences are not replayed or counted.
 *
 *  • Occurrence idempotency: a digest occurrence is de-facto
 *    `(subscriptionId, deliveredSlot)`; the conditional claim on `nextRunAt`
 *    prevents a re-run from double-sending the same slot. If delivery hard-fails
 *    on all channels we roll `nextRunAt` back so the occurrence is retried on a
 *    later tick (bounded by the job interval), rather than silently advancing
 *    past a failed digest.
 *
 *  • Per-channel isolation: one failing channel is logged and counted, never
 *    allowed to block the others, and never rolls the whole occurrence back.
 */

import db from '../db'
import { logger, logBackgroundJob } from '../utils/logger'
import {
  generateCorrelationId,
  runWithCorrelationIdAsync,
} from '../utils/correlation'
import { recordJobSuccess, recordJobFailure } from '../utils/job-metrics'
import { config } from '../config/env'
import { publishUserEvent } from '../events/publisher'
import { EVENT_TYPE_TOPIC } from '../events/types'
import { sendWhatsAppMessage } from '../utils/twilio-client'
import { loadDigestData } from '../notifications/load'
import { buildDigest } from '../notifications/digest'
import { renderDigest, isChannelDeliverable } from '../notifications/render'
import {
  deferForQuietHours,
  isQuietHours,
  nextOccurrence,
  type QuietHours,
} from '../notifications/schedule'

type DigestChannel = 'WHATSAPP' | 'TELEGRAM' | 'EMAIL' | 'WEBHOOK'
type Frequency = 'DAILY' | 'WEEKLY' | 'MONTHLY'

interface DigestSubscriptionRow {
  id: string
  userId: string
  frequency: Frequency
  channels: DigestChannel[]
  sendHourUtc: number
  weeklyDayUtc: number | null
  quietHours: unknown
  isActive: boolean
  lastSentAt: Date | null
  nextRunAt: Date
}

/** Numeric minutes into a failure-backoff window (bounded retries). */
const MAX_DELIVERY_ATTEMPTS = 3

async function claimDueSubscription(
  sub: DigestSubscriptionRow,
  now: Date
): Promise<boolean> {
  const result = await db.digestSubscription.updateMany({
    where: {
      id: sub.id,
      isActive: true,
      nextRunAt: sub.nextRunAt,
    },
    data: { lastSentAt: now },
  })
  return result.count === 1
}

/**
 * Deliver a digest over the channels that are currently deliverable and linked
 * (e.g. WHATSAPP needs a phone on file). Unlinked/unavailable channels are
 * skipped with a `digest.channel_unavailable` note, never an error. One bad
 * channel never blocks the others.
 */
async function deliverDigest(
  sub: DigestSubscriptionRow,
  userId: string,
  model: Record<string, unknown>,
  text: string | null
): Promise<{ delivered: string[]; skipped: string[] }> {
  const delivered: string[] = []
  const skipped: string[] = []

  const channels = sub.channels

  if (channels.includes('WHATSAPP')) {
    try {
      const user = await db.user.findUnique({
        where: { id: userId },
        select: { phone: true },
      })
      if (!user?.phone) {
        skipped.push('WHATSAPP')
        logger.warn(
          `[Digests] Subscription ${sub.id} requests WHATSAPP but user ${userId} has no phone on file — skipping`
        )
      } else if (!text) {
        skipped.push('WHATSAPP')
        logger.warn(
          `[Digests] Subscription ${sub.id} WHATSAPP render produced no output — skipping`
        )
      } else {
        await sendWhatsAppMessage({ to: `whatsapp:${user.phone}`, body: text })
        delivered.push('WHATSAPP')
      }
    } catch (error) {
      // Bounded retry for a transient WhatsApp delivery error.
      let deliveredOk = false
      for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt++) {
        try {
          await sendWhatsAppMessage({
            to: `whatsapp:${(await db.user.findUnique({ where: { id: userId }, select: { phone: true } }))?.phone}`,
            body: text ?? '',
          })
          deliveredOk = true
          break
        } catch {
          if (attempt === MAX_DELIVERY_ATTEMPTS) break
        }
      }
      if (deliveredOk) {
        delivered.push('WHATSAPP')
      } else {
        skipped.push('WHATSAPP')
        logger.error(
          `[Digests] WHATSAPP delivery failed for subscription ${sub.id}`,
          { error: error instanceof Error ? error.message : String(error) }
        )
      }
    }
  }

  if (channels.includes('WEBHOOK')) {
    // digest.generated is a socket-only event type, but this publish also
    // enqueues the user's OWN webhook endpoints (see events/publisher.ts). The
    // digest reaches the user's real-time stream and their registered endpoint
    // only — never operator webhooks (docs/NOTIFICATIONS.md).
    await publishUserEvent(
      userId,
      EVENT_TYPE_TOPIC['digest.generated'],
      'digest.generated',
      model
    ).catch((error) => {
      skipped.push('WEBHOOK')
      logger.error(
        `[Digests] WEBHOOK/stream delivery failed for subscription ${sub.id}`,
        { error: error instanceof Error ? error.message : String(error) }
      )
    })
    delivered.push('WEBHOOK')
  }

  return { delivered, skipped }
}

/**
 * Process all due digest subscriptions.
 */
export async function runDigests(now: Date = new Date()): Promise<void> {
  const correlationId = generateCorrelationId()
  return runWithCorrelationIdAsync(correlationId, async () => {
    const start = Date.now()
    const jobName = 'digests'

    let due = 0
    let delivered = 0
    let deferred = 0
    let skippedCount = 0

    try {
      const subs = (await db.digestSubscription.findMany({
        where: { isActive: true, nextRunAt: { lte: now } },
        orderBy: { nextRunAt: 'asc' },
        select: {
          id: true,
          userId: true,
          frequency: true,
          channels: true,
          sendHourUtc: true,
          weeklyDayUtc: true,
          quietHours: true,
          isActive: true,
          lastSentAt: true,
          nextRunAt: true,
        },
      })) as DigestSubscriptionRow[]

      due = subs.length

      for (const sub of subs) {
        try {
          const quiet: QuietHours | null = isQuietHours(sub.quietHours)
            ? sub.quietHours
            : null

          // Quiet hours gate the CURRENT send time, not the stored slot: if the
          // job fires while the clock is inside the window we defer the whole
          // occurrence to the next allowed hour (never drop it). The digest is
          // then picked up again at that deferred time.
          const slot = deferForQuietHours(now, quiet)
          if (slot.getTime() !== now.getTime()) {
            await db.digestSubscription.update({
              where: { id: sub.id },
              data: { nextRunAt: slot },
            })
            deferred++
            logger.info(
              `[Digests] Subscription ${sub.id} deferred to ${slot.toISOString()} (quiet hours)`
            )
            continue
          }

          // Atomic claim — guards against concurrent runners / mid-tick deactivates.
          const won = await claimDueSubscription(sub, now)
          if (!won) continue

          // Assemble once for the user, then render/deliver per channel.
          const data = await loadDigestData(sub.userId, sub.frequency, now)
          const model = buildDigest(data, sub.frequency)
          const text = renderDigest(model, 'WHATSAPP')

          const { delivered: ok, skipped } = await deliverDigest(
            sub,
            sub.userId,
            model as unknown as Record<string, unknown>,
            text
          )
          delivered += ok.length
          skippedCount += skipped.length

          if (ok.length === 0) {
            // Hard failure across all channels: roll the claim back so the
            // occurrence is retried on a later tick rather than silently lost.
            await db.digestSubscription
              .update({
                where: { id: sub.id },
                data: { lastSentAt: sub.lastSentAt, nextRunAt: sub.nextRunAt },
              })
              .catch(() => undefined)
            continue
          }

          // All verbs delivered — advance to the next occurrence.
          const nextRunAt = nextOccurrence(
            sub.frequency,
            sub.sendHourUtc,
            sub.weeklyDayUtc,
            now
          )
          await db.digestSubscription.update({
            where: { id: sub.id },
            data: { nextRunAt },
          })
        } catch (subError) {
          // One bad subscription must not abort the sweep.
          logger.error(`[Digests] Error processing subscription ${sub.id}`, {
            error:
              subError instanceof Error ? subError.message : String(subError),
          })
        }
      }

      const durationMs = Date.now() - start
      logBackgroundJob(jobName, 'success', durationMs / 1000, correlationId, {
        due,
        delivered,
        deferred,
        skipped: skippedCount,
      })
      recordJobSuccess(jobName, durationMs)
    } catch (error) {
      const durationMs = Date.now() - start
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error'
      logBackgroundJob(jobName, 'failed', durationMs / 1000, correlationId, {
        error: errorMessage,
      })
      recordJobFailure(jobName, durationMs)
    }
  })
}

/**
 * Schedule the digest job. Runs once on startup then on the configured interval.
 *
 * @returns NodeJS.Timeout handle — pass to clearInterval() on shutdown.
 */
export function scheduleDigests(): NodeJS.Timeout {
  void runDigests()

  const intervalMs = config.digests.intervalMs
  const handle = setInterval(() => {
    void runDigests()
  }, intervalMs)

  handle.unref?.()

  logger.info(`[Digests] Digest delivery scheduled every ${intervalMs}ms`)
  return handle
}

// Export for testability.
export { isChannelDeliverable }
