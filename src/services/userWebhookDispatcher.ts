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
