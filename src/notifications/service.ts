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
  const preference = await db.notificationPreference.findUnique({
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

/**
 * Check if a notification should be sent based on preferences
 */
export async function shouldSendNotification(
  userId: string,
  channel: NotificationChannel,
  category: NotificationCategory
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
    const now = new Date()
    const userHour = getHourInTimezone(now, preference.quietHours.timezone)
    const { startHour, endHour } = preference.quietHours

    // Handle overnight quiet hours (e.g., 22:00 to 06:00)
    if (startHour > endHour) {
      if (userHour >= startHour || userHour < endHour) {
        return false
      }
    } else {
      if (userHour >= startHour && userHour < endHour) {
        return false
      }
    }
  }

  return true
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
 * Get delivery status for a user's notifications
 */
export async function getDeliveryStatus(
  userId: string
): Promise<NotificationDeliveryStatus[]> {
  // This would query a notification delivery tracking table
  // For now, return empty array as placeholder
  return []
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
 * Get current hour in a specific timezone
 */
function getHourInTimezone(date: Date, timezone: string): number {
  return parseInt(
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
    }).format(date),
    10
  )
}
