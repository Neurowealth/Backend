import db from '../db'
import { logger } from '../utils/logger'
import {
  outboundNotificationAttempts,
  outboundNotificationDlqSize,
} from '../utils/metrics'

export type OutboundNotificationChannel =
  | 'email'
  | 'sms'
  | 'whatsapp'
  | 'telegram'

const MAX_ATTEMPTS = Math.max(1, Number(process.env.NOTIFICATION_MAX_ATTEMPTS) || 8)
const BASE_DELAY_MS = Math.max(100, Number(process.env.NOTIFICATION_BASE_DELAY_MS) || 1000)
const MAX_DELAY_MS = Math.max(BASE_DELAY_MS, Number(process.env.NOTIFICATION_MAX_DELAY_MS) || 300000)
const BATCH_SIZE = 50

type NotificationRecord = {
  id: string
  channel: OutboundNotificationChannel
  payload: Record<string, unknown>
  attempts: number
}

export async function enqueueOutboundNotification(
  channel: OutboundNotificationChannel,
  payload: Record<string, unknown>
): Promise<string> {
  const notification = await (db as any).outboundNotification.create({
    data: { channel, payload },
  })
  void dispatchOutboundNotifications().catch((error) =>
    logger.error('[Notifications] Immediate dispatch failed', {
      notificationId: notification.id,
      error: error instanceof Error ? error.message : String(error),
    })
  )
  return notification.id
}

async function deliver(notification: NotificationRecord): Promise<string> {
  const payload = notification.payload
  switch (notification.channel) {
    case 'email': {
      const { mailRegistry } = await import('../mail/mailProvider')
      const result = await mailRegistry.deliverQueued(payload as any)
      return result.messageId
    }
    case 'sms':
    case 'whatsapp': {
      const { sendTwilioMessageNow } = await import('../utils/twilio-client')
      return sendTwilioMessageNow(
        payload as { to: string; body: string },
        notification.channel
      )
    }
    case 'telegram': {
      const token = process.env.TELEGRAM_BOT_TOKEN
      if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured')
      const response = await fetch(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10_000),
        }
      )
      if (!response.ok) throw new Error(`Telegram API returned HTTP ${response.status}`)
      const result = (await response.json()) as { result?: { message_id?: number } }
      return String(result.result?.message_id ?? 'accepted')
    }
  }
  throw new Error(`Unsupported outbound notification channel: ${notification.channel}`)
}

function retryDelayMs(attempt: number): number {
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1))
  return Math.floor(Math.random() * ceiling)
}

export async function dispatchOutboundNotifications(): Promise<void> {
  const model = (db as any).outboundNotification
  const now = new Date()

  await model.updateMany({
    where: {
      status: 'PROCESSING',
      updatedAt: { lt: new Date(now.getTime() - 5 * 60 * 1000) },
    },
    data: { status: 'RETRYING', nextAttemptAt: now },
  })

  const batch = (await model.findMany({
    where: {
      status: { in: ['PENDING', 'RETRYING'] },
      nextAttemptAt: { lte: now },
    },
    orderBy: { createdAt: 'asc' },
    take: BATCH_SIZE,
  })) as NotificationRecord[]

  for (const notification of batch) {
    const claim = await model.updateMany({
      where: {
        id: notification.id,
        status: { in: ['PENDING', 'RETRYING'] },
      },
      data: { status: 'PROCESSING', attempts: { increment: 1 } },
    })
    if (claim.count !== 1) continue

    const attempt = notification.attempts + 1
    try {
      const providerId = await deliver(notification)
      await model.update({
        where: { id: notification.id },
        data: { status: 'DELIVERED', providerId, lastError: null },
      })
      outboundNotificationAttempts.inc({ channel: notification.channel, status: 'delivered' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const dead = attempt >= MAX_ATTEMPTS
      await model.update({
        where: { id: notification.id },
        data: {
          status: dead ? 'DEAD' : 'RETRYING',
          lastError: message,
          nextAttemptAt: new Date(Date.now() + retryDelayMs(attempt)),
        },
      })
      outboundNotificationAttempts.inc({
        channel: notification.channel,
        status: dead ? 'dead' : 'retrying',
      })
      logger.warn('[Notifications] Delivery attempt failed', {
        notificationId: notification.id,
        channel: notification.channel,
        attempt,
        dead,
        error: message,
      })
    }
  }

  const deadCount = await model.count({ where: { status: 'DEAD' } })
  outboundNotificationDlqSize.set(deadCount)
}

export async function listDeadOutboundNotifications(limit = 100) {
  return (db as any).outboundNotification.findMany({
    where: { status: 'DEAD' },
    select: {
      id: true,
      channel: true,
      attempts: true,
      lastError: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: { createdAt: 'asc' },
    take: Math.min(Math.max(limit, 1), 500),
  })
}

export async function retryDeadOutboundNotification(id: string): Promise<boolean> {
  const result = await (db as any).outboundNotification.updateMany({
    where: { id, status: 'DEAD' },
    data: {
      status: 'PENDING',
      attempts: 0,
      lastError: null,
      nextAttemptAt: new Date(),
    },
  })
  return result.count === 1
}

export function scheduleOutboundNotifications(): NodeJS.Timeout {
  const handle = setInterval(() => {
    dispatchOutboundNotifications().catch((error) =>
      logger.error('[Notifications] Queue dispatch failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    )
  }, 10_000)
  handle.unref()
  return handle
}