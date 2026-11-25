/**
 * Notification preference management service
 * Handles user notification settings, unsubscribes, and audit trails
 */

import db from '../db'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { logger } from '../utils/logger'
import {
  generateCorrelationId,
  runWithCorrelationIdAsync,
} from '../utils/correlation'
import {
  NotificationChannel,
  NotificationCategory,
  NotificationPreference,
  UnsubscribeRequest,
  UnsubscribeConfirmation,
  NotificationPreferenceAuditLog,
  NotificationDeliveryStatus,
} from './types'

/**
 * Get all notification preferences for a user
 */
export async function getUserPreferences(
  userId: string
): Promise<NotificationPreference[]> {
  const preferences = await db.notificationPreference.findMany({
    where: { userId },
    orderBy: { channel: 'asc' },
  })
  return preferences as unknown as NotificationPreference[]
}

/**
 * Get preference for a specific channel and category
 */
export async function getUserPreference(
  userId: string,
  channel: NotificationChannel,
  category: NotificationCategory
): Promise<NotificationPreference | null> {
  const model = (
    db as unknown as {
      notificationPreference?: {
        findUnique?: (args: unknown) => Promise<unknown>
      }
    }
  )?.notificationPreference
  if (!model?.findUnique) {
    return null
  }
  const preference = await model.findUnique({
    where: {
      userId_channel_category: {
        userId,
        channel,
        category,
      },
    },
  })
  return preference as NotificationPreference | null
}

/**
 * Update or create a notification preference
 */
export async function setPreference(
  userId: string,
  channel: NotificationChannel,
  category: NotificationCategory,
  enabled: boolean,
  options?: {
    quietHours?: NotificationPreference['quietHours']
    frequency?: NotificationPreference['frequency']
    updatedBy?: NotificationPreference['updatedBy']
  }
): Promise<NotificationPreference> {
  const correlationId = generateCorrelationId()
  return runWithCorrelationIdAsync(correlationId, async () => {
    const existing = await getUserPreference(userId, channel, category)
    const updatedBy = options?.updatedBy || 'user'

    // Log the change to audit trail
    if (existing) {
      await logPreferenceChange({
        userId,
        action: enabled ? 'enabled' : 'disabled',
        channel,
        category,
        previousValue: existing.enabled,
        newValue: enabled,
        changedBy: updatedBy,
        metadata: {
          quietHours: options?.quietHours,
          frequency: options?.frequency,
        },
      })
    } else {
      await logPreferenceChange({
        userId,
        action: enabled ? 'enabled' : 'disabled',
        channel,
        category,
        previousValue: false, // Default to disabled for new preferences
        newValue: enabled,
        changedBy: updatedBy,
        metadata: {
          isNew: true,
          quietHours: options?.quietHours,
          frequency: options?.frequency,
        },
      })
    }

    const preference = await db.notificationPreference.upsert({
      where: {
        userId_channel_category: {
          userId,
          channel,
          category,
        },
      },
      create: {
        userId,
        channel,
        category,
        enabled,
        quietHours: options?.quietHours,
        frequency: options?.frequency,
        updatedAt: new Date(),
        updatedBy,
      },
      update: {
        enabled,
        quietHours: options?.quietHours,
        frequency: options?.frequency,
        updatedAt: new Date(),
        updatedBy,
      },
    })

    logger.info(`[Notifications] Preference updated`, {
      correlationId,
      userId,
      channel,
      category,
      enabled,
      updatedBy,
    })

    return preference as unknown as NotificationPreference
  })
}

/**
 * Enable all notifications for a channel
 */
export async function enableChannel(
  userId: string,
  channel: NotificationChannel
): Promise<NotificationPreference[]> {
  const categories: NotificationCategory[] = [
    'portfolio_updates',
    'rebalance_alerts',
    'yield_claims',
    'risk_alerts',
    'system_updates',
    'marketing',
  ]

  const preferences = await Promise.all(
    categories.map((category) =>
      setPreference(userId, channel, category, true, { updatedBy: 'user' })
    )
  )

  return preferences
}

/**
 * Disable all notifications for a channel
 */
export async function disableChannel(
  userId: string,
  channel: NotificationChannel
): Promise<NotificationPreference[]> {
  const categories: NotificationCategory[] = [
    'portfolio_updates',
    'rebalance_alerts',
    'yield_claims',
    'risk_alerts',
    'system_updates',
    'marketing',
  ]

  const preferences = await Promise.all(
    categories.map((category) =>
      setPreference(userId, channel, category, false, { updatedBy: 'user' })
    )
  )

  return preferences
}

function isHourInQuietWindow(
  hour: number,
  startHour: number,
  endHour: number
): boolean {
  if (startHour === endHour) return false
  if (startHour > endHour) {
    return hour >= startHour || hour < endHour
  }
  return hour >= startHour && hour < endHour
}

/**
 * Check if a notification should be sent based on preferences
 */
export async function shouldSendNotification(
  userId: string,
  channel: NotificationChannel,
  category: NotificationCategory,
  now: Date = new Date()
): Promise<boolean> {
  const preference = await getUserPreference(userId, channel, category)

  // If no preference exists, default to enabled for critical categories
  if (!preference) {
    const criticalCategories: NotificationCategory[] = [
      'portfolio_updates',
      'rebalance_alerts',
      'risk_alerts',
      'system_updates',
    ]
    return criticalCategories.includes(category)
  }

  // Check if preference is enabled
  if (!preference.enabled) {
    return false
  }

  // Check quiet hours
  if (preference.quietHours?.enabled) {
    const userHour = getHourInTimezone(now, preference.quietHours.timezone)
    const { startHour, endHour } = preference.quietHours
    if (isHourInQuietWindow(userHour, startHour, endHour)) {
      return false
    }
  }

  return true
}

/**
 * If a notification is enabled for the user/channel/category but currently
 * suppressed due to quiet hours, returns the Date when the quiet window ends
 * so callers can defer rather than drop the notification. Returns null when
 * disabled or not inside quiet hours.
 */
export async function getQuietHoursDeferUntil(
  userId: string,
  channel: NotificationChannel,
  category: NotificationCategory,
  now: Date = new Date()
): Promise<Date | null> {
  const preference = await getUserPreference(userId, channel, category)
  if (!preference || !preference.enabled || !preference.quietHours?.enabled) {
    return null
  }

  const { startHour, endHour, timezone } = preference.quietHours
  const { hour: userHour, minute: userMinute } = getTimePartsInTimezone(
    now,
    timezone
  )
  if (!isHourInQuietWindow(userHour, startHour, endHour)) {
    return null
  }

  // Step hourly starting from the next local top-of-hour (:00 in timezone)
  // until the quiet window ends (handles DST and half-hour offsets cleanly).
  const baseMinuteMs = Math.floor(now.getTime() / 60_000) * 60_000
  const minutesToNextLocalHour = 60 - userMinute
  let candidate = new Date(baseMinuteMs + minutesToNextLocalHour * 60_000)

  for (let i = 0; i < 24; i++) {
    const candidateHour = getHourInTimezone(candidate, timezone)
    if (!isHourInQuietWindow(candidateHour, startHour, endHour)) {
      return candidate
    }
    candidate = new Date(candidate.getTime() + 60 * 60_000)
  }

  return null
}

export function generateUnsubscribeToken(userId: string): string {
  const secret = getUnsubscribeSecret()
  const timestamp = Date.now()
  const payload = `${userId}:${timestamp}`
  const signature = createHmac('sha256', secret)
    .update(payload)
    .digest('base64url')
  return `${timestamp}.${signature}`
}

/**
 * Verify unsubscribe token
 */
export function verifyUnsubscribeToken(token: string, userId: string): boolean {
  try {
    const [timestamp, signature] = token.split('.')
    if (!timestamp || !signature || !/^\d+$/.test(timestamp)) {
      return false
    }

    const expectedSignature = createHmac('sha256', getUnsubscribeSecret())
      .update(`${userId}:${timestamp}`)
      .digest()
    const providedSignature = Buffer.from(signature, 'base64url')
    if (
      providedSignature.length !== expectedSignature.length ||
      !timingSafeEqual(providedSignature, expectedSignature)
    ) {
      return false
    }

    const tokenAge = Date.now() - Number(timestamp)
    const maxAge = 7 * 24 * 60 * 60 * 1000 // 7 days in milliseconds

    return tokenAge >= 0 && tokenAge < maxAge
  } catch {
    return false
  }
}

function getUnsubscribeSecret(): string {
  const secret =
    process.env.UNSUBSCRIBE_TOKEN_SECRET ||
    process.env.JWT_SECRET ||
    process.env.JWT_SEED
  if (!secret) {
    throw new Error(
      'Unsubscribe token signing is not configured: set UNSUBSCRIBE_TOKEN_SECRET'
    )
  }
  return secret
}

/**
 * Process unsubscribe request
 */
export async function processUnsubscribe(
  request: UnsubscribeRequest,
  metadata?: {
    ipAddress?: string
    userAgent?: string
  }
): Promise<UnsubscribeConfirmation> {
  const correlationId = generateCorrelationId()
  return runWithCorrelationIdAsync(correlationId, async () => {
    // Verify token
    if (!verifyUnsubscribeToken(request.token, request.userId)) {
      throw new Error('Invalid or expired unsubscribe token')
    }

    const categories = request.category
      ? [request.category]
      : ([
          'portfolio_updates',
          'rebalance_alerts',
          'yield_claims',
          'risk_alerts',
          'system_updates',
          'marketing',
        ] as NotificationCategory[])

    // Disable preferences
    for (const category of categories) {
      await setPreference(request.userId, request.channel, category, false, {
        updatedBy: 'user',
      })

      // Log unsubscribe action
      await logPreferenceChange({
        userId: request.userId,
        action: 'unsubscribed',
        channel: request.channel,
        category,
        previousValue: true, // Assume it was enabled
        newValue: false,
        changedBy: 'user',
        metadata: {
          reason: request.reason,
          ipAddress: metadata?.ipAddress,
          userAgent: metadata?.userAgent,
        },
      })
    }

    const confirmation: UnsubscribeConfirmation = {
      requestId: generateCorrelationId(),
      userId: request.userId,
      channel: request.channel,
      categories,
      confirmedAt: new Date(),
      ipAddress: metadata?.ipAddress,
      userAgent: metadata?.userAgent,
    }

    logger.info(`[Notifications] Unsubscribe processed`, {
      correlationId,
      userId: request.userId,
      channel: request.channel,
      categories,
      reason: request.reason,
    })

    return confirmation
  })
}

/**
 * Get delivery status for a user's notifications (#699).
 *
 * Aggregates per-channel delivery state from the two durable delivery
 * stores — `message_deliveries` (Telegram/WhatsApp, user-scoped) and
 * `outbound_notifications` (email/sms/whatsapp/telegram queue) — so callers
 * get a real per-channel report instead of a placeholder.
 */
export async function getDeliveryStatus(
  userId: string
): Promise<NotificationDeliveryStatus[]> {
  const [messages, outbound] = await Promise.all([
    db.messageDelivery.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      take: 500,
    }),
    db.outboundNotification.findMany({
      orderBy: { updatedAt: 'desc' },
      take: 500,
    }),
  ])

  const byKey = new Map<string, NotificationDeliveryStatus>()

  const keyFor = (channel: string, category: string) =>
    `${channel}::${category}`

  const toChannel = (raw: string): NotificationChannel => {
    const lower = raw.toLowerCase()
    if (
      lower === 'telegram' ||
      lower === 'whatsapp' ||
      lower === 'email' ||
      lower === 'sms' ||
      lower === 'push'
    )
      return lower
    return 'email'
  }

  const toCategory = (raw: unknown): NotificationCategory => {
    const lower = String(raw ?? '').toLowerCase()
    const known: NotificationCategory[] = [
      'portfolio_updates',
      'rebalance_alerts',
      'yield_claims',
      'risk_alerts',
      'system_updates',
      'marketing',
    ]
    return (known as string[]).includes(lower)
      ? (lower as NotificationCategory)
      : 'system_updates'
  }

  for (const msg of messages as Array<{
    channel: string
    category: string
    status: string
    deliveredAt: Date | null
    updatedAt: Date
    lastError: string | null
    attempts: number
  }>) {
    const channel = toChannel(msg.channel)
    const category = toCategory(msg.category)
    const key = keyFor(channel, category)
    const existing = byKey.get(key)
    const delivered = msg.status === 'DELIVERED' && msg.deliveredAt
    const failed = msg.status === 'FAILED' || msg.status === 'DEAD_LETTER'
    if (!existing) {
      byKey.set(key, {
        userId,
        channel,
        category,
        lastDeliveredAt: delivered ? (msg.deliveredAt as Date) : undefined,
        lastFailedAt: failed ? msg.updatedAt : undefined,
        failureCount: failed ? 1 : 0,
        lastError: failed ? (msg.lastError ?? undefined) : undefined,
      })
    } else {
      if (
        delivered &&
        (!existing.lastDeliveredAt ||
          msg.deliveredAt! > existing.lastDeliveredAt)
      ) {
        existing.lastDeliveredAt = msg.deliveredAt as Date
      }
      if (failed) {
        existing.failureCount += 1
        if (!existing.lastFailedAt || msg.updatedAt > existing.lastFailedAt) {
          existing.lastFailedAt = msg.updatedAt
          existing.lastError = msg.lastError ?? undefined
        }
      }
    }
  }

  // Outbound queue rows carry the recipient in `payload`, not a userId
  // column, so they can only refine channel-level state (latest failure /
  // delivery timestamps) — per-user attribution stays with message_deliveries.
  for (const row of outbound as Array<{
    channel: string
    status: string
    updatedAt: Date
    lastError: string | null
    payload: unknown
  }>) {
    const channel = toChannel(row.channel)
    const payload = (row.payload ?? {}) as Record<string, unknown>
    const category = toCategory(
      payload['category'] ?? payload['notificationCategory'] ?? 'system_updates'
    )
    const key = keyFor(channel, category)
    const existing = byKey.get(key)
    const failed = row.status === 'DEAD'
    const delivered = row.status === 'DELIVERED'
    if (!existing) {
      byKey.set(key, {
        userId,
        channel,
        category,
        lastDeliveredAt: undefined,
        lastFailedAt: failed ? row.updatedAt : undefined,
        failureCount: failed ? 1 : 0,
        lastError: failed ? (row.lastError ?? undefined) : undefined,
      })
    } else if (failed && !delivered) {
      existing.failureCount += 1
      if (!existing.lastFailedAt || row.updatedAt > existing.lastFailedAt) {
        existing.lastFailedAt = row.updatedAt
        existing.lastError = row.lastError ?? undefined
      }
    }
  }

  return [...byKey.values()]
}

/**
 * Log preference change to audit trail
 */
async function logPreferenceChange(
  log: Omit<NotificationPreferenceAuditLog, 'id' | 'changedAt'>
): Promise<void> {
  await db.notificationPreferenceAuditLog.create({
    data: {
      userId: log.userId,
      action: log.action,
      channel: log.channel,
      category: log.category,
      previousValue: log.previousValue,
      newValue: log.newValue,
      changedBy: log.changedBy,
      changedAt: new Date(),
      metadata: log.metadata as any,
    },
  })
}

/**
 * Get audit log for a user's preferences
 */
export async function getPreferenceAuditLog(
  userId: string,
  limit: number = 50
): Promise<NotificationPreferenceAuditLog[]> {
  const logs = await db.notificationPreferenceAuditLog.findMany({
    where: { userId },
    orderBy: { changedAt: 'desc' },
    take: limit,
  })
  return logs as NotificationPreferenceAuditLog[]
}

/**
 * Get current hour and minute in a specific timezone (0..23, 0..59).
 */
function getTimePartsInTimezone(
  date: Date,
  timezone: string
): { hour: number; minute: number } {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(date)
    const hourPart = parts.find((p) => p.type === 'hour')?.value
    const minutePart = parts.find((p) => p.type === 'minute')?.value
    const hour = parseInt(hourPart ?? '', 10)
    const minute = parseInt(minutePart ?? '', 10)
    return {
      hour: Number.isFinite(hour) ? hour % 24 : date.getUTCHours(),
      minute: Number.isFinite(minute) ? minute % 60 : date.getUTCMinutes(),
    }
  } catch {
    return { hour: date.getUTCHours(), minute: date.getUTCMinutes() }
  }
}

/**
 * Get current hour in a specific timezone
 */
function getHourInTimezone(date: Date, timezone: string): number {
  return getTimePartsInTimezone(date, timezone).hour
}
