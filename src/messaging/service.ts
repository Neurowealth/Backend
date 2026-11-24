import crypto from 'node:crypto'
import type { Prisma } from '@prisma/client'
import db from '../db'
import { config } from '../config'
import { logger } from '../utils/logger'
import { alertingService } from '../services/alerting'
import {
  sendTelegramMessage,
  isTelegramTransientError,
  extractTelegramRetryAfter,
} from '../utils/telegram-client'
import {
  sendWhatsAppMessage,
  isWhatsAppTransientError,
  extractWhatsAppRetryAfter,
} from '../utils/twilio-client'
import {
  recordMessageDelivery,
  recordMessageRetry,
  recordMessageFallback,
  recordMessageDeadLetter,
  updateMessageQueueDepth,
} from '../utils/metrics'
import type {
  MessageChannel,
  MessageDeliveryRecord,
  MessageDeliveryStatus,
  MessagePriority,
  SendMessageInput,
  ListMessagesFilter,
  MessageStats,
} from './types'

// Storage for unit tests that run without a database.
const inMemoryStore = new Map<string, MessageDeliveryRecord>()
const SENDING_TIMEOUT_MS = 5 * 60 * 1000

class DeliveryPersistenceError extends Error {
  constructor(readonly cause: unknown) {
    super('Could not persist the message delivery outcome')
  }
}

function sanitizeRecipient(recipient: string): string {
  if (recipient.length <= 6) return '***'
  return `${recipient.slice(0, 3)}***${recipient.slice(-3)}`
}

function shouldQueryDb(): boolean {
  if (process.env.NODE_ENV === 'test') {
    const md = (db as any)?.messageDelivery
    if (!md) return false
    return Boolean(
      md.create?._isMockFunction ||
      typeof md.create?.mockResolvedValue === 'function' ||
      process.env.USE_REAL_DB_FOR_TESTS === 'true'
    )
  }
  return true
}

export class MessageDeliveryService {
  private static instance: MessageDeliveryService

  public static getInstance(): MessageDeliveryService {
    if (!MessageDeliveryService.instance) {
      MessageDeliveryService.instance = new MessageDeliveryService()
    }
    return MessageDeliveryService.instance
  }

  /**
   * Calculate exponential backoff with full jitter.
   */
  public calculateBackoff(attempt: number, retryAfterSeconds?: number): number {
    if (retryAfterSeconds && retryAfterSeconds > 0) {
      return retryAfterSeconds * 1000
    }
    const base = config.messaging.baseDelayMs
    const max = config.messaging.maxDelayMs
    const exponential = Math.min(max, base * 2 ** Math.max(0, attempt - 1))
    return Math.floor(Math.random() * exponential) + 50
  }

  /**
   * Persist a delivery record before making a provider request.
   */
  private async persistRecord(record: MessageDeliveryRecord): Promise<void> {
    if (shouldQueryDb()) {
      const { metadata, ...data } = record
      await db.messageDelivery.create({
        data: {
          ...data,
          metadata: (metadata as Prisma.InputJsonObject | null) ?? undefined,
        },
      })
    } else {
      inMemoryStore.set(record.id, { ...record })
    }
  }

  private async updateRecord(
    record: MessageDeliveryRecord,
    claimTime?: Date
  ): Promise<void> {
    record.updatedAt = new Date()
    if (!shouldQueryDb()) {
      inMemoryStore.set(record.id, { ...record })
      return
    }

    const {
      status,
      attempts,
      nextAttemptAt,
      lastError,
      providerMessageId,
      fallbackChannel,
      fallbackRecipient,
      fallbackTriggered,
      deliveredAt,
      updatedAt,
    } = record
    const data = {
      status,
      attempts,
      nextAttemptAt,
      lastError,
      providerMessageId,
      fallbackChannel,
      fallbackRecipient,
      fallbackTriggered,
      deliveredAt,
      updatedAt,
    }

    try {
      if (claimTime) {
        const result = await db.messageDelivery.updateMany({
          where: { id: record.id, status: 'SENDING', updatedAt: claimTime },
          data,
        })
        if (result.count !== 1)
          throw new Error('Message delivery claim expired')
      } else {
        await db.messageDelivery.update({ where: { id: record.id }, data })
      }
    } catch (error) {
      throw new DeliveryPersistenceError(error)
    }
  }

  private async claimRecord(
    record: MessageDeliveryRecord,
    claimedAt: Date
  ): Promise<boolean> {
    if (shouldQueryDb()) {
      const result = await db.messageDelivery.updateMany({
        where: {
          id: record.id,
          status: 'PENDING',
          updatedAt: record.updatedAt,
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: claimedAt } }],
        },
        data: { status: 'SENDING', updatedAt: claimedAt },
      })
      return result.count === 1
    }
    const current = inMemoryStore.get(record.id)
    if (
      current?.status !== 'PENDING' ||
      current.updatedAt.getTime() !== record.updatedAt.getTime() ||
      (current.nextAttemptAt && current.nextAttemptAt > claimedAt)
    )
      return false
    inMemoryStore.set(record.id, {
      ...current,
      status: 'SENDING',
      updatedAt: claimedAt,
    })
    return true
  }

  /**
   * Find a delivery record by ID.
   */
  public async getMessage(id: string): Promise<MessageDeliveryRecord | null> {
    if (shouldQueryDb()) {
      try {
        const row = await (db as any).messageDelivery.findUnique({
          where: { id },
        })
        if (row) return row as MessageDeliveryRecord
      } catch {
        // Fall through to memory store
      }
    }
    return inMemoryStore.get(id) ?? null
  }

  /**
   * Queue or immediately send a message.
   */
  public async send(
    input: SendMessageInput,
    options?: { immediate?: boolean }
  ): Promise<MessageDeliveryRecord> {
    const id = crypto.randomUUID()
    const now = new Date()

    const record: MessageDeliveryRecord = {
      id,
      channel: input.channel,
      recipient: input.recipient,
      userId: input.userId ?? null,
      category: input.category || 'NOTIFICATION',
      body: input.body,
      status: 'PENDING',
      priority: input.priority || 'NORMAL',
      attempts: 0,
      maxAttempts: input.maxAttempts || config.messaging.maxRetries || 5,
      nextAttemptAt: null,
      lastError: null,
      providerMessageId: null,
      metadata: input.metadata || null,
      fallbackChannel: input.fallbackChannel ?? null,
      fallbackRecipient: input.fallbackRecipient ?? null,
      fallbackTriggered: false,
      deliveredAt: null,
      createdAt: now,
      updatedAt: now,
    }

    await this.persistRecord(record)

    const shouldSendImmediate = options?.immediate ?? true
    if (shouldSendImmediate) {
      return await this.dispatchSingle(record)
    }

    return record
  }

  /**
   * Execute delivery for a single record.
   */
  public async dispatchSingle(
    record: MessageDeliveryRecord
  ): Promise<MessageDeliveryRecord> {
    return (
      (await this.dispatchPending(record)) ??
      (await this.getMessage(record.id)) ??
      record
    )
  }

  private async dispatchPending(
    record: MessageDeliveryRecord
  ): Promise<MessageDeliveryRecord | null> {
    const claimedAt = new Date()
    if (!(await this.claimRecord(record, claimedAt))) return null
    record = { ...record, status: 'SENDING', updatedAt: claimedAt }

    const startTime = Date.now()

    try {
      let providerMessageId: string | null = null

      if (record.channel === 'TELEGRAM') {
        const result = await sendTelegramMessage({
          chatId: record.recipient,
          text: record.body,
        })
        providerMessageId = result.messageId
      } else if (record.channel === 'WHATSAPP') {
        const to = record.recipient.startsWith('whatsapp:')
          ? record.recipient
          : `whatsapp:${record.recipient}`
        const sid = await sendWhatsAppMessage({
          to,
          body: record.body,
        })
        providerMessageId = sid
      } else {
        throw new Error(`Unsupported message channel: ${record.channel}`)
      }

      // Success
      const durationSeconds = (Date.now() - startTime) / 1000
      record.attempts += 1
      record.status = 'DELIVERED'
      record.deliveredAt = new Date()
      record.providerMessageId = providerMessageId
      record.lastError = null
      record.nextAttemptAt = null

      await this.updateRecord(record, claimedAt)
      recordMessageDelivery(
        record.channel,
        'DELIVERED',
        record.category,
        durationSeconds
      )

      logger.info('[Messaging] Message successfully delivered', {
        id: record.id,
        channel: record.channel,
        recipient: sanitizeRecipient(record.recipient),
        category: record.category,
        attempts: record.attempts,
        providerMessageId,
      })

      return record
    } catch (error) {
      if (error instanceof DeliveryPersistenceError) throw error
      const durationSeconds = (Date.now() - startTime) / 1000
      record.attempts += 1
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      record.lastError = errorMessage

      recordMessageRetry(record.channel)

      const isTransient =
        record.channel === 'TELEGRAM'
          ? isTelegramTransientError(error)
          : isWhatsAppTransientError(error)

      const retryAfter =
        record.channel === 'TELEGRAM'
          ? extractTelegramRetryAfter(error)
          : extractWhatsAppRetryAfter(error)

      logger.warn('[Messaging] Message delivery attempt failed', {
        id: record.id,
        channel: record.channel,
        recipient: sanitizeRecipient(record.recipient),
        attempts: record.attempts,
        maxAttempts: record.maxAttempts,
        isTransient,
        error: errorMessage,
      })

      // If transient and we have attempts remaining, schedule retry
      if (isTransient && record.attempts < record.maxAttempts) {
        const delayMs = this.calculateBackoff(record.attempts, retryAfter)
        record.status = 'PENDING'
        record.nextAttemptAt = new Date(Date.now() + delayMs)

        await this.updateRecord(record, claimedAt)
        recordMessageDelivery(
          record.channel,
          'RETRYING',
          record.category,
          durationSeconds
        )

        return record
      }

      // If attempts exhausted or terminal, check fallback policy
      if (config.messaging.fallbackEnabled && !record.fallbackTriggered) {
        const fallback = await this.resolveFallback(record)
        if (fallback) {
          logger.warn(
            `[Messaging] Triggering fallback from ${record.channel} to ${fallback.channel}`,
            {
              id: record.id,
              fromChannel: record.channel,
              toChannel: fallback.channel,
              recipient: sanitizeRecipient(fallback.recipient),
            }
          )

          record.fallbackTriggered = true
          record.fallbackChannel = fallback.channel
          record.fallbackRecipient = fallback.recipient
          recordMessageFallback(record.channel, fallback.channel)

          // Try dispatching immediately over fallback channel
          try {
            let fallbackProviderId: string | null = null
            if (fallback.channel === 'TELEGRAM') {
              const res = await sendTelegramMessage({
                chatId: fallback.recipient,
                text: record.body,
              })
              fallbackProviderId = res.messageId
            } else if (fallback.channel === 'WHATSAPP') {
              const to = fallback.recipient.startsWith('whatsapp:')
                ? fallback.recipient
                : `whatsapp:${fallback.recipient}`
              fallbackProviderId = await sendWhatsAppMessage({
                to,
                body: record.body,
              })
            }

            record.status = 'DELIVERED'
            record.deliveredAt = new Date()
            record.providerMessageId = fallbackProviderId
            record.lastError = null
            record.nextAttemptAt = null

            await this.updateRecord(record, claimedAt)
            recordMessageDelivery(
              fallback.channel,
              'DELIVERED_FALLBACK',
              record.category
            )

            logger.info(
              '[Messaging] Message successfully delivered via fallback',
              {
                id: record.id,
                fallbackChannel: fallback.channel,
                recipient: sanitizeRecipient(fallback.recipient),
              }
            )

            return record
          } catch (fallbackError) {
            if (fallbackError instanceof DeliveryPersistenceError)
              throw fallbackError
            logger.error('[Messaging] Fallback delivery also failed', {
              id: record.id,
              fallbackChannel: fallback.channel,
              error:
                fallbackError instanceof Error
                  ? fallbackError.message
                  : String(fallbackError),
            })
            record.lastError = `Primary failed (${errorMessage}); Fallback failed: ${
              fallbackError instanceof Error
                ? fallbackError.message
                : String(fallbackError)
            }`
          }
        }
      }

      // No fallback or fallback failed — move to DEAD_LETTER
      record.status = 'DEAD_LETTER'
      record.nextAttemptAt = null
      await this.updateRecord(record, claimedAt)

      recordMessageDeadLetter(record.channel)
      recordMessageDelivery(
        record.channel,
        'DEAD_LETTER',
        record.category,
        durationSeconds
      )

      logger.error('[Messaging] Message delivery moved to DEAD_LETTER', {
        id: record.id,
        channel: record.channel,
        recipient: sanitizeRecipient(record.recipient),
        attempts: record.attempts,
        lastError: record.lastError,
      })

      // Emit alert
      await alertingService
        .emit(
          {
            title: `Message Delivery Dead-Lettered (${record.channel})`,
            description: `Message ${record.id} to ${sanitizeRecipient(
              record.recipient
            )} failed after ${record.attempts} attempts: ${record.lastError}`,
            severity: 'warning',
            component: 'messaging',
            metadata: {
              messageId: record.id,
              channel: record.channel,
              category: record.category,
              attempts: record.attempts,
              recipient: sanitizeRecipient(record.recipient),
              error: record.lastError,
            },
          },
          `dead_letter:${record.id}`
        )
        .catch(() => {})

      return record
    }
  }

  /**
   * Determine fallback channel and recipient if available.
   */
  private async resolveFallback(
    record: MessageDeliveryRecord
  ): Promise<{ channel: MessageChannel; recipient: string } | null> {
    if (record.fallbackChannel && record.fallbackRecipient) {
      return {
        channel: record.fallbackChannel,
        recipient: record.fallbackRecipient,
      }
    }

    // Try resolving alternate channel via linked user records
    try {
      if (record.channel === 'WHATSAPP') {
        // Fallback from WhatsApp to Telegram
        if (record.userId) {
          const user = await db.user.findUnique({
            where: { id: record.userId },
            select: { walletAddress: true },
          })
          if (user?.walletAddress) {
            const { getTelegramUser } = await import('../telegram/userManager')
            // Check memory store for matching wallet
            const tlgUser = getTelegramUser(user.walletAddress)
            if (tlgUser?.chatId) {
              return { channel: 'TELEGRAM', recipient: tlgUser.chatId }
            }
          }
        }
      } else if (record.channel === 'TELEGRAM') {
        // Fallback from Telegram to WhatsApp
        if (record.userId) {
          const user = await db.user.findUnique({
            where: { id: record.userId },
            select: { phone: true },
          })
          if (user?.phone) {
            return { channel: 'WHATSAPP', recipient: user.phone }
          }
        }
      }
    } catch {
      // Ignore resolution error
    }

    return null
  }

  /**
   * Process pending/retrying messages in the queue whose nextAttemptAt <= now.
   */
  public async processPendingQueue(batchSize: number = 50): Promise<{
    processed: number
    delivered: number
    retried: number
    deadLettered: number
  }> {
    const now = new Date()
    const staleBefore = new Date(now.getTime() - SENDING_TIMEOUT_MS)
    let candidates: MessageDeliveryRecord[]

    if (shouldQueryDb()) {
      await db.messageDelivery.updateMany({
        where: { status: 'SENDING', updatedAt: { lt: staleBefore } },
        data: { status: 'PENDING', nextAttemptAt: null, updatedAt: now },
      })
      const rows = await db.messageDelivery.findMany({
        where: {
          status: 'PENDING',
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
        },
        orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
        take: batchSize,
      })
      candidates = rows as MessageDeliveryRecord[]
    } else {
      candidates = Array.from(inMemoryStore.values())
        .filter(
          (m) =>
            m.status === 'PENDING' &&
            (!m.nextAttemptAt || m.nextAttemptAt <= now)
        )
        .slice(0, batchSize)
    }

    let processed = 0
    let delivered = 0
    let retried = 0
    let deadLettered = 0

    // Process with concurrency limit of 5
    const concurrency = 5
    for (let i = 0; i < candidates.length; i += concurrency) {
      const chunk = candidates.slice(i, i + concurrency)
      await Promise.all(
        chunk.map(async (msg) => {
          const result = await this.dispatchPending(msg)
          if (!result) return
          processed++
          if (result.status === 'DELIVERED') delivered++
          else if (result.status === 'PENDING') retried++
          else if (result.status === 'DEAD_LETTER') deadLettered++
        })
      )
    }

    // Update gauge depth metrics
    await this.refreshQueueMetrics().catch(() => {})

    return {
      processed,
      delivered,
      retried,
      deadLettered,
    }
  }

  /**
   * Update queue depth metrics in Prometheus.
   */
  public async refreshQueueMetrics(): Promise<void> {
    const stats = await this.getMessageStats()
    updateMessageQueueDepth(
      'TELEGRAM',
      'PENDING',
      stats.byChannel.telegram.pending
    )
    updateMessageQueueDepth(
      'TELEGRAM',
      'DEAD_LETTER',
      stats.byChannel.telegram.deadLetter
    )
    updateMessageQueueDepth(
      'WHATSAPP',
      'PENDING',
      stats.byChannel.whatsapp.pending
    )
    updateMessageQueueDepth(
      'WHATSAPP',
      'DEAD_LETTER',
      stats.byChannel.whatsapp.deadLetter
    )
  }

  /**
   * Manual recovery: force-retry a specific message.
   */
  public async retryMessage(id: string): Promise<MessageDeliveryRecord> {
    const msg = await this.getMessage(id)
    if (!msg) {
      throw new Error(`Message with id ${id} not found`)
    }

    msg.status = 'PENDING'
    msg.attempts = 0
    msg.nextAttemptAt = new Date()
    msg.lastError = null
    msg.fallbackTriggered = false

    await this.updateRecord(msg)
    logger.info(`[Messaging] Manual retry initiated for message ${id}`)
    return await this.dispatchSingle(msg)
  }

  /**
   * Manual recovery: bulk retry all dead-lettered messages.
   */
  public async retryAllDeadLetters(
    channel?: MessageChannel
  ): Promise<{ count: number }> {
    let deadLetters: MessageDeliveryRecord[] = []

    if (shouldQueryDb()) {
      try {
        deadLetters = await (db as any).messageDelivery.findMany({
          where: {
            status: 'DEAD_LETTER',
            ...(channel ? { channel } : {}),
          },
        })
      } catch {
        // Memory fallback
      }
    }

    if (!deadLetters || deadLetters.length === 0) {
      deadLetters = Array.from(inMemoryStore.values()).filter(
        (m) => m.status === 'DEAD_LETTER' && (!channel || m.channel === channel)
      )
    }

    for (const msg of deadLetters) {
      msg.status = 'PENDING'
      msg.nextAttemptAt = new Date()
      msg.attempts = 0
      msg.lastError = null
      msg.fallbackTriggered = false
      await this.updateRecord(msg)
    }

    logger.info(
      `[Messaging] Reset ${deadLetters.length} dead-lettered messages to PENDING for re-attempt`
    )

    // Trigger processing
    void this.processPendingQueue(deadLetters.length).catch(() => {})

    return { count: deadLetters.length }
  }

  /**
   * Cancel an unsent or dead-letter message.
   */
  public async cancelMessage(id: string): Promise<MessageDeliveryRecord> {
    const msg = await this.getMessage(id)
    if (!msg) {
      throw new Error(`Message with id ${id} not found`)
    }

    msg.status = 'FAILED'
    msg.lastError = 'Cancelled by administrator'
    msg.nextAttemptAt = null
    await this.updateRecord(msg)

    logger.info(`[Messaging] Cancelled message ${id}`)
    return msg
  }

  /**
   * List messages with filter and pagination.
   */
  public async listMessages(filter: ListMessagesFilter = {}): Promise<{
    messages: MessageDeliveryRecord[]
    total: number
  }> {
    const limit = Math.min(filter.limit || 50, 500)
    const offset = filter.offset || 0

    if (shouldQueryDb()) {
      try {
        const where: any = {}
        if (filter.channel) where.channel = filter.channel
        if (filter.status) where.status = filter.status
        if (filter.recipient) where.recipient = { contains: filter.recipient }
        if (filter.userId) where.userId = filter.userId
        if (filter.category) where.category = filter.category

        const [messages, total] = await Promise.all([
          (db as any).messageDelivery.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            take: limit,
            skip: offset,
          }),
          (db as any).messageDelivery.count({ where }),
        ])

        return { messages, total }
      } catch {
        // Memory fallback
      }
    }

    let all = Array.from(inMemoryStore.values())
    if (filter.channel) all = all.filter((m) => m.channel === filter.channel)
    if (filter.status) all = all.filter((m) => m.status === filter.status)
    if (filter.recipient)
      all = all.filter((m) => m.recipient.includes(filter.recipient!))
    if (filter.userId) all = all.filter((m) => m.userId === filter.userId)
    if (filter.category) all = all.filter((m) => m.category === filter.category)

    all.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    return {
      messages: all.slice(offset, offset + limit),
      total: all.length,
    }
  }

  /**
   * Get queue and delivery stats.
   */
  public async getMessageStats(): Promise<MessageStats> {
    const defaultStats: MessageStats = {
      total: 0,
      byStatus: {
        pending: 0,
        sending: 0,
        delivered: 0,
        failed: 0,
        deadLetter: 0,
      },
      byChannel: {
        telegram: {
          total: 0,
          delivered: 0,
          failed: 0,
          pending: 0,
          deadLetter: 0,
        },
        whatsapp: {
          total: 0,
          delivered: 0,
          failed: 0,
          pending: 0,
          deadLetter: 0,
        },
      },
    }

    if (shouldQueryDb()) {
      try {
        const rows = await (db as any).messageDelivery.groupBy({
          by: ['channel', 'status'],
          _count: { _all: true },
        })

        for (const row of rows) {
          const count = row._count._all
          defaultStats.total += count

          if (row.status === 'PENDING') defaultStats.byStatus.pending += count
          else if (row.status === 'SENDING')
            defaultStats.byStatus.sending += count
          else if (row.status === 'DELIVERED')
            defaultStats.byStatus.delivered += count
          else if (row.status === 'FAILED')
            defaultStats.byStatus.failed += count
          else if (row.status === 'DEAD_LETTER')
            defaultStats.byStatus.deadLetter += count

          const channelKey =
            row.channel === 'TELEGRAM' ? 'telegram' : 'whatsapp'
          defaultStats.byChannel[channelKey].total += count

          if (row.status === 'DELIVERED')
            defaultStats.byChannel[channelKey].delivered += count
          else if (row.status === 'FAILED')
            defaultStats.byChannel[channelKey].failed += count
          else if (row.status === 'PENDING' || row.status === 'SENDING')
            defaultStats.byChannel[channelKey].pending += count
          else if (row.status === 'DEAD_LETTER')
            defaultStats.byChannel[channelKey].deadLetter += count
        }

        return defaultStats
      } catch {
        // Memory fallback
      }
    }

    for (const msg of inMemoryStore.values()) {
      defaultStats.total += 1
      if (msg.status === 'PENDING') defaultStats.byStatus.pending += 1
      else if (msg.status === 'SENDING') defaultStats.byStatus.sending += 1
      else if (msg.status === 'DELIVERED') defaultStats.byStatus.delivered += 1
      else if (msg.status === 'FAILED') defaultStats.byStatus.failed += 1
      else if (msg.status === 'DEAD_LETTER')
        defaultStats.byStatus.deadLetter += 1

      const ch = msg.channel === 'TELEGRAM' ? 'telegram' : 'whatsapp'
      defaultStats.byChannel[ch].total += 1
      if (msg.status === 'DELIVERED') defaultStats.byChannel[ch].delivered += 1
      else if (msg.status === 'FAILED') defaultStats.byChannel[ch].failed += 1
      else if (msg.status === 'PENDING' || msg.status === 'SENDING')
        defaultStats.byChannel[ch].pending += 1
      else if (msg.status === 'DEAD_LETTER')
        defaultStats.byChannel[ch].deadLetter += 1
    }

    return defaultStats
  }

  /**
   * Reset store for unit tests.
   */
  public clearStoreForTests(): void {
    inMemoryStore.clear()
  }
}

export const messageDeliveryService = MessageDeliveryService.getInstance()
