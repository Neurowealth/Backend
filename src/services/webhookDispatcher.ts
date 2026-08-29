import crypto from 'node:crypto'
import db from '../db'
import { logger } from '../utils/logger'
import { buildSignatureHeader } from '../utils/webhookSignature'
import type { WebhookEvent } from '../validators/webhook-validators'
import {
  isSubscriptionDeliverable,
  recordDeliverySuccess,
  recordDeliveryFailure,
  recordHalfOpenProbe,
  getSubscriptionHealth,
} from './webhookCircuitBreaker'

const MAX_ATTEMPTS = parseInt(process.env.WEBHOOK_MAX_ATTEMPTS || '6')
const BASE_DELAY_MS = parseInt(process.env.WEBHOOK_BASE_DELAY_MS || '1000')
const DELIVERY_TIMEOUT_MS = parseInt(
  process.env.WEBHOOK_DELIVERY_TIMEOUT_MS || '10000'
)
const WORKER_POOL_SIZE = parseInt(process.env.WEBHOOK_WORKER_POOL_SIZE || '5')

interface SubscriptionRow {
  id: string
  url: string
  secret: string
  secretNext?: string | null
  userId: string
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function fullJitterDelay(attempt: number): number {
  const max = BASE_DELAY_MS * 2 ** (attempt - 1)
  return Math.floor(Math.random() * max)
}

function getSigningSecrets(sub: SubscriptionRow): string[] {
  const secrets = [sub.secret]
  if (sub.secretNext) secrets.push(sub.secretNext)
  return secrets
}

function isPrivateOrLocalUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return true
    const host = parsed.hostname
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host.startsWith('10.') ||
      host.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    ) {
      return true
    }
    return false
  } catch {
    return true
  }
}

async function moveToDeadLetter(
  sub: SubscriptionRow,
  event: string,
  payload: Record<string, unknown>,
  attempts: number,
  lastError: string,
  firstFailedAt: Date
): Promise<void> {
  await (db as any).webhookDeadLetter.create({
    data: {
      subscriptionId: sub.id,
      event,
      payload,
      firstFailedAt,
      lastError,
      attempts,
      status: 'PENDING',
    },
  })
}

async function deliverOnce(
  sub: SubscriptionRow,
  event: string,
  payload: string,
  deliveryId: string,
  isReplay: boolean,
  occurredAt?: string
): Promise<{ ok: boolean; statusCode?: number; error?: string }> {
  if (isPrivateOrLocalUrl(sub.url)) {
    return { ok: false, error: 'SSRF: destination URL not allowed' }
  }

  const timestamp = Math.floor(Date.now() / 1000)
  const secrets = getSigningSecrets(sub)
  const signature = buildSignatureHeader(
    secrets,
    payload,
    timestamp,
    deliveryId
  )

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-NW-Webhook-Timestamp': String(timestamp),
    'X-NW-Webhook-Id': deliveryId,
    'X-NW-Webhook-Signature': signature,
    'X-Neurowealth-Signature': signature,
  }
  if (isReplay) {
    headers['X-NW-Webhook-Replay'] = 'true'
    if (occurredAt) headers['X-NW-Webhook-Original-At'] = occurredAt
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS)

  try {
    const res = await fetch(sub.url, {
      method: 'POST',
      headers,
      body: payload,
      signal: controller.signal,
    })
    clearTimeout(timer)

    if (res.ok) return { ok: true, statusCode: res.status }
    return { ok: false, statusCode: res.status, error: `HTTP ${res.status}` }
  } catch (err) {
    clearTimeout(timer)
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export async function deliverToSubscription(
  sub: SubscriptionRow,
  event: string,
  payloadObj: Record<string, unknown>,
  options: { isReplay?: boolean; occurredAt?: string } = {}
): Promise<void> {
  const h = getSubscriptionHealth(sub.id)

  if (!isSubscriptionDeliverable(sub.id)) {
    await moveToDeadLetter(
      sub,
      event,
      payloadObj,
      0,
      'Circuit breaker open — delivery skipped',
      new Date()
    )
    if (h.shouldAutoDisable) {
      await (db as any).webhookSubscription.update({
        where: { id: sub.id },
        data: { isActive: false },
      })
      logger.warn(
        '[Webhook] Auto-disabled subscription after prolonged circuit open',
        {
          subscriptionId: sub.id,
        }
      )
    }
    return
  }

  const payload = JSON.stringify(payloadObj)
  const deliveryId = crypto.randomUUID()
  const firstFailedAt = new Date()

  const delivery = await (db as any).webhookDelivery.create({
    data: {
      subscriptionId: sub.id,
      event,
      payload: payloadObj,
      status: 'PENDING',
    },
  })

  let lastError = ''
  let statusCode: number | undefined
  const isHalfOpen = h.state === 'half_open'

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = await deliverOnce(
      sub,
      event,
      payload,
      deliveryId,
      options.isReplay ?? false,
      options.occurredAt
    )

    statusCode = result.statusCode
    if (result.ok) {
      await (db as any).webhookDelivery.update({
        where: { id: delivery.id },
        data: { status: 'SUCCESS', statusCode, attempts: attempt, error: null },
      })
      if (isHalfOpen) {
        recordHalfOpenProbe(sub.id, true)
      } else {
        recordDeliverySuccess(sub.id)
      }
      return
    }

    lastError = result.error ?? 'Unknown error'
    logger.warn(
      `[Webhook] Attempt ${attempt}/${MAX_ATTEMPTS} failed for ${sub.url}: ${lastError}`
    )

    if (attempt < MAX_ATTEMPTS) {
      await sleep(fullJitterDelay(attempt))
    }
  }

  await (db as any).webhookDelivery.update({
    where: { id: delivery.id },
    data: {
      status: 'FAILED',
      statusCode: statusCode ?? null,
      attempts: MAX_ATTEMPTS,
      error: lastError,
    },
  })

  if (isHalfOpen) {
    recordHalfOpenProbe(sub.id, false)
  } else {
    recordDeliveryFailure(sub.id)
  }

  await moveToDeadLetter(
    sub,
    event,
    payloadObj,
    MAX_ATTEMPTS,
    lastError,
    firstFailedAt
  )

  logger.error(`[Webhook] Exhausted attempts for subscription ${sub.id}`, {
    url: sub.url,
    error: lastError,
  })
}

/** Bounded worker pool for parallel fan-out (#377). */
async function runWithPool<T>(
  items: T[],
  fn: (item: T) => Promise<void>
): Promise<void> {
  let index = 0
  const workers = Array.from(
    { length: Math.min(WORKER_POOL_SIZE, items.length) },
    async () => {
      while (index < items.length) {
        const i = index++
        await fn(items[i])
      }
    }
  )
  await Promise.allSettled(workers)
}

/**
 * Dispatch a webhook event to all active subscriptions that listen for it.
 */
export async function dispatchWebhookEvent(
  event: WebhookEvent,
  data: Record<string, unknown>
): Promise<void> {
  const subscriptions = await (db as any).webhookSubscription.findMany({
    where: {
      isActive: true,
      events: { has: event },
    },
  })

  if (subscriptions.length === 0) return

  const payloadObj = {
    event,
    data,
    timestamp: new Date().toISOString(),
  }

  await runWithPool(subscriptions as SubscriptionRow[], (sub) =>
    deliverToSubscription(sub, event, payloadObj)
  )
}

/** Replay a dead-letter entry with a fresh delivery id (#377). */
export async function replayDeadLetter(deadLetterId: string): Promise<boolean> {
  const dl = await (db as any).webhookDeadLetter.findUnique({
    where: { id: deadLetterId },
    include: { subscription: true },
  })
  if (!dl || dl.status !== 'PENDING') return false

  const payload = dl.payload as Record<string, unknown>
  await deliverToSubscription(dl.subscription, dl.event, payload, {
    isReplay: true,
    occurredAt: dl.firstFailedAt.toISOString(),
  })

  await (db as any).webhookDeadLetter.update({
    where: { id: deadLetterId },
    data: { status: 'REPLAYED' },
  })
  return true
}
