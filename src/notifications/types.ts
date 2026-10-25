/**
 * Notification preference management types
 * Supports Telegram, WhatsApp, Email, and SMS channels
 */

export type NotificationChannel = 'telegram' | 'whatsapp' | 'email' | 'sms'

export type NotificationCategory =
  | 'portfolio_updates'
  | 'rebalance_alerts'
  | 'yield_claims'
  | 'risk_alerts'
  | 'system_updates'
  | 'marketing'

export type NotificationPreference = {
  userId: string
  channel: NotificationChannel
  category: NotificationCategory
  enabled: boolean
  quietHours?: {
    enabled: boolean
    startHour: number // 0-23
    endHour: number // 0-23
    timezone: string // IANA timezone, e.g., 'America/New_York'
  }
  frequency?: 'immediate' | 'daily' | 'weekly'
  updatedAt: Date
  updatedBy: 'user' | 'admin' | 'system'
}

export type UnsubscribeRequest = {
  userId: string
  channel: NotificationChannel
  category?: NotificationCategory // If undefined, unsubscribe from all categories
  reason?: string
  token: string // Verification token to prevent abuse
}

export type UnsubscribeConfirmation = {
  requestId: string
  userId: string
  channel: NotificationChannel
  categories: NotificationCategory[]
  confirmedAt: Date
  ipAddress?: string
  userAgent?: string
}

export type NotificationPreferenceAuditLog = {
  id: string
  userId: string
  action: 'enabled' | 'disabled' | 'updated' | 'unsubscribed'
  channel: NotificationChannel
  category: NotificationCategory
  previousValue: boolean
  newValue: boolean
  changedBy: 'user' | 'admin' | 'system'
  changedAt: Date
  metadata?: Record<string, unknown>
}

export type NotificationDeliveryStatus = {
  userId: string
  channel: NotificationChannel
  category: NotificationCategory
  lastDeliveredAt?: Date
  lastFailedAt?: Date
  failureCount: number
  lastError?: string
}
