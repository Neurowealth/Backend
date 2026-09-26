export type MessageChannel = 'TELEGRAM' | 'WHATSAPP'

export type MessageDeliveryStatus =
  | 'PENDING'
  | 'SENDING'
  | 'DELIVERED'
  | 'FAILED'
  | 'DEAD_LETTER'

export type MessagePriority = 'HIGH' | 'NORMAL' | 'LOW'

export interface MessageDeliveryRecord {
  id: string
  channel: MessageChannel
  recipient: string
  userId: string | null
  category: string
  body: string
  status: MessageDeliveryStatus
  priority: MessagePriority
  attempts: number
  maxAttempts: number
  nextAttemptAt: Date | null
  lastError: string | null
  providerMessageId: string | null
  metadata: Record<string, unknown> | null
  fallbackChannel: MessageChannel | null
  fallbackRecipient: string | null
  fallbackTriggered: boolean
  deliveredAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface SendMessageInput {
  channel: MessageChannel
  recipient: string
  body: string
  userId?: string | null
  category?: string
  priority?: MessagePriority
  maxAttempts?: number
  metadata?: Record<string, unknown>
  fallbackChannel?: MessageChannel
  fallbackRecipient?: string
}

export interface ListMessagesFilter {
  channel?: MessageChannel
  status?: MessageDeliveryStatus
  recipient?: string
  userId?: string
  category?: string
  limit?: number
  offset?: number
}

export interface MessageStats {
  total: number
  byStatus: {
    pending: number
    sending: number
    delivered: number
    failed: number
    deadLetter: number
  }
  byChannel: {
    telegram: {
      total: number
      delivered: number
      failed: number
      pending: number
      deadLetter: number
    }
    whatsapp: {
      total: number
      delivered: number
      failed: number
      pending: number
      deadLetter: number
    }
  }
}
