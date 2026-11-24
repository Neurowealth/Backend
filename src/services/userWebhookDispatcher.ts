import crypto from 'node:crypto'
import URL from 'node:url'
import db from '../db'
import { logger } from '../utils/logger'
import { evaluateFilterPredicate } from '../utils/userWebhookFilter'

export const USER_WEBHOOK_MAX_ATTEMPTS = 5
export const USER_WEBHOOK_MAX_CONSECUTIVE_FAILURES = 5
export const USER_WEBHOOK_TIMEOUT_MS = 5000

/**
 * Validates a webhook URL against SSRF (Server-Side Request Forgery) attacks (#368).
 * Enforces HTTPS scheme and rejects private / loopback / link-local IP addresses and hosts.
 */
export function validateSsrfUrl(urlString: string): void {
  let parsed: URL.UrlWithParsedQuery
  try {
    parsed = URL.parse(urlString, true)
  } catch {
    throw new Error('Invalid webhook URL format')
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('Webhook URL must use the https:// protocol')
  }

  const hostname = (parsed.hostname || '').toLowerCase().trim()
  if (!hostname) {
    throw new Error('Webhook URL hostname is missing')
  }

  // Reject local/private hostnames & IPs
  const privateHostPatterns = [
    /^localhost$/i,
    /^127\.\d+\.\d+\.\d+$/,
    /^10\.\d+\.\d+\.\d+$/,
    /^172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+$/,
    /^192\.168\.\d+\.\d+$/,
    /^169\.254\.\d+\.\d+$/,
    /^0\.0\.0\.0$/,
    /^::1$/,
    /^fe80:/i,
    /^fc00:/i,
    /^fd00:/i,
  ]

  if (privateHostPatterns.some((pattern) => pattern.test(hostname))) {
    throw new Error(
      `Forbidden webhook URL: hostname "${hostname}" resolves to a private or loopback range`
    )
  }
}

/**
 * Signs a payload using HMAC-SHA256 with timestamp header format `t=timestamp,v1=signature`.
 */
export function signUserWebhookPayload(
  payloadString: string,
  secret: string,
  timestamp: number = Math.floor(Date.now() / 1000)
): string {
  const signaturePayload = `${timestamp}.${payloadString}`
  const signature = crypto
    .createHmac('sha256', secret)
    .update(signaturePayload)
    .digest('hex')
  return `t=${timestamp},v1=${signature}`
}

/**
 * Hash a secret for secure storage in the database.
 */
export function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex')
}

/**
 * Enqueues user-scoped webhook deliveries for a published domain event.
 * Reuses the redacted socket payload and durable stream seq.
 */
export async function enqueueUserWebhooks(
  userId: string,
  topic: string,
  type: string,
  seq: number,
  redactedPayload: Record<string, any>
): Promise<void> {
  try {
    const endpoints = await db.userWebhookEndpoint.findMany({
      where: {
        userId,
        status: 'ACTIVE',
      },
    })

    if (!endpoints || endpoints.length === 0) return

    for (const endpoint of endpoints) {
      // Check event allowlist
      if (endpoint.events.length > 0 && !endpoint.events.includes(type)) {
        continue
      }

      // Check topic scope
      if (
        endpoint.topicScope.length > 0 &&
        !endpoint.topicScope.includes(topic)
      ) {
        continue
      }

      // Check server-side filter predicate
      if (
        endpoint.filterJson &&
        !evaluateFilterPredicate(endpoint.filterJson as any, redactedPayload)
      ) {
        continue
      }

      // Enqueue delivery record with idempotency key @@unique([endpointId, userEventSeq])
      try {
        await db.userWebhookDelivery.create({
          data: {
            endpointId: endpoint.id,
            userEventSeq: seq,
            eventType: type,
            payload: redactedPayload,
            status: 'PENDING',
            attempts: 0,
            nextAttemptAt: new Date(),
          },
        })
      } catch (err: any) {
        // P2002 Unique constraint violation means already enqueued/delivered
        if (err?.code !== 'P2002') {
          logger.warn(
            '[UserWebhookDispatcher] Failed to create delivery record',
            {
              endpointId: endpoint.id,
              seq,
              error: err.message,
            }
          )
        }
      }
    }
  } catch (error) {
    logger.error('[UserWebhookDispatcher] Error enqueueing user webhooks', {
      userId,
      type,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export interface ProcessUserWebhooksResult {
  processed: number
  delivered: number
  retried: number
  failed: number
}

async function handleDeliveryFailure(
  delivery: { id: string; attempts: number },
  endpoint: { id: string; consecutiveFailures: number },
  error: string,
  responseCode?: number
): Promise<boolean> {
  const nextAttempts = delivery.attempts + 1

  if (nextAttempts >= USER_WEBHOOK_MAX_ATTEMPTS) {
    // Terminal failure for this delivery
    await db.userWebhookDelivery.update({
      where: { id: delivery.id },
      data: {
        status: 'FAILED',
        attempts: nextAttempts,
        responseCode: responseCode || null,
        error,
      },
    })

    // Increment consecutive failures on endpoint and check auto-disable
    const nextFailures = endpoint.consecutiveFailures + 1
    const shouldDisable = nextFailures >= USER_WEBHOOK_MAX_CONSECUTIVE_FAILURES

    await db.userWebhookEndpoint.update({
      where: { id: endpoint.id },
      data: {
        consecutiveFailures: nextFailures,
        ...(shouldDisable
          ? {
              status: 'PAUSED',
              isActive: false,
            }
          : {}),
      },
    })

    if (shouldDisable) {
      logger.warn(
        `[UserWebhookDispatcher] Endpoint ${endpoint.id} auto-disabled after ${nextFailures} consecutive failures`
      )
    }

    return true
  }

  // Backoff retry: 1s, 2s, 4s, 8s, 16s...
  const delayMs = Math.min(1000 * Math.pow(2, nextAttempts - 1), 60000)
  const nextAttemptAt = new Date(Date.now() + delayMs)

  await db.userWebhookDelivery.update({
    where: { id: delivery.id },
    data: {
      status: 'PENDING',
      attempts: nextAttempts,
      nextAttemptAt,
      responseCode: responseCode || null,
      error,
    },
  })

  return false
}

/**
 * Claims and processes pending user-scoped webhook deliveries.
 * Applies compare-and-set concurrency control, HMAC signing, timeout,
 * exponential backoff, and endpoint auto-disable.
 */
export async function processUserWebhookDeliveries(
  batchSize: number = 50,
  now: Date = new Date()
): Promise<ProcessUserWebhooksResult> {
  const result: ProcessUserWebhooksResult = {
    processed: 0,
    delivered: 0,
    retried: 0,
    failed: 0,
  }

  // 1. Fetch pending rows ready for delivery
  const pendingDeliveries = await db.userWebhookDelivery.findMany({
    where: {
      status: 'PENDING',
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    include: {
      endpoint: true,
    },
    take: batchSize,
    orderBy: { createdAt: 'asc' },
  })

  if (!pendingDeliveries || pendingDeliveries.length === 0) {
    return result
  }

  for (const delivery of pendingDeliveries) {
    // 2. Compare-and-set claim: PENDING -> PROCESSING
    const claim = await db.userWebhookDelivery.updateMany({
      where: {
        id: delivery.id,
        status: 'PENDING',
      },
      data: {
        status: 'PROCESSING',
      },
    })

    if (claim.count === 0) {
      // Already claimed by a concurrent worker
      continue
    }

    result.processed++

    const endpoint = delivery.endpoint
    if (!endpoint || endpoint.status !== 'ACTIVE' || !endpoint.isActive) {
      await db.userWebhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: 'FAILED',
          error: 'Endpoint is not active or paused',
        },
      })
      result.failed++
      continue
    }

    // 3. Re-check URL against SSRF rules at send time
    try {
      validateSsrfUrl(endpoint.url)
    } catch (ssrfErr: any) {
      const errorMsg =
        ssrfErr instanceof Error ? ssrfErr.message : String(ssrfErr)
      await handleDeliveryFailure(delivery, endpoint, errorMsg, 0)
      result.failed++
      continue
    }

    // 4. Prepare payload
    let payloadObj = delivery.payload as Record<string, any> | null
    if (!payloadObj && delivery.userEventSeq) {
      const userEvent = await db.userEvent.findFirst({
        where: {
          userId: endpoint.userId,
          seq: delivery.userEventSeq,
        },
      })
      if (userEvent?.payload) {
        payloadObj = userEvent.payload as Record<string, any>
      }
    }

    const payloadString = JSON.stringify(
      payloadObj ?? {
        id: delivery.id,
        eventType: delivery.eventType,
        seq: delivery.userEventSeq ? Number(delivery.userEventSeq) : undefined,
      }
    )

    // 5. Sign payload with signUserWebhookPayload
    const timestamp = Math.floor(Date.now() / 1000)
    const secret = endpoint.secret || ''
    const signature = signUserWebhookPayload(payloadString, secret, timestamp)

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-User-Webhook-Timestamp': String(timestamp),
      'X-User-Webhook-Signature': signature,
      'X-Neurowealth-Signature': signature,
      'User-Agent': 'Neurowealth-UserWebhook/1.0',
    }

    // 6. Send with timeout
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), USER_WEBHOOK_TIMEOUT_MS)

    try {
      const res = await fetch(endpoint.url, {
        method: 'POST',
        headers,
        body: payloadString,
        signal: controller.signal,
      })
      clearTimeout(timer)

      if (res.ok) {
        await db.userWebhookDelivery.update({
          where: { id: delivery.id },
          data: {
            status: 'DELIVERED',
            responseCode: res.status,
            attempts: delivery.attempts + 1,
            error: null,
          },
        })

        await db.userWebhookEndpoint.update({
          where: { id: endpoint.id },
          data: {
            consecutiveFailures: 0,
            lastDeliveryAt: new Date(),
          },
        })

        result.delivered++
      } else {
        const errorMsg = `HTTP ${res.status}: ${res.statusText || 'Delivery failed'}`
        const isTerminal = await handleDeliveryFailure(
          delivery,
          endpoint,
          errorMsg,
          res.status
        )
        if (isTerminal) {
          result.failed++
        } else {
          result.retried++
        }
      }
    } catch (sendErr: any) {
      clearTimeout(timer)
      const errorMsg =
        sendErr instanceof Error ? sendErr.message : String(sendErr)
      const isTerminal = await handleDeliveryFailure(
        delivery,
        endpoint,
        errorMsg,
        0
      )
      if (isTerminal) {
        result.failed++
      } else {
        result.retried++
      }
    }
  }

  return result
}
