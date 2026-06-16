/**
 * Dead-letter queue for Stellar events that failed to process.
 *
 * Storage layer: `dead_letter_events` table via Prisma. Prior to this change the
 * queue lived in `logs/dead_letter_queue.json`, which did not survive container
 * rebuilds and is not safe under concurrent writes. `migrateFromLegacyFile`
 * provides a one-shot import path from that file when present — call it once
 * from your startup sequence and delete the file when migration succeeds.
 */
import * as fs from 'fs'
import * as path from 'path'
import { xdr } from '@stellar/stellar-sdk'
import { logger } from '../utils/logger'
import db from '../db'
import { updateDlqSize } from '../utils/metrics'
import { config } from '../config'
import { alertingService, type DLQAlertPayload } from '../services/alerting'

export type DeadLetterEventStatus = 'PENDING' | 'RETRIED' | 'RESOLVED'

export interface DeadLetterEvent {
  id: string
  contractId: string
  txHash: string
  eventType: string
  ledger: number
  error: string
  payload: any
  status: DeadLetterEventStatus
  retryCount: number
  createdAt: string
  updatedAt: string
}

const LEGACY_DLQ_FILE = path.join(
  __dirname,
  '../../logs/dead_letter_queue.json'
)

function serializeScVal(value: unknown): string | unknown {
  if (value instanceof xdr.ScVal) {
    return value.toXDR('base64')
  }
  return value
}

function deserializeScVal(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return xdr.ScVal.fromXDR(value, 'base64')
  } catch {
    return value
  }
}

function serializePayload(event: any): any {
  return {
    ...event,
    topics: Array.isArray(event?.topics)
      ? event.topics.map((topic: unknown) => serializeScVal(topic))
      : event?.topics,
    value: serializeScVal(event?.value),
  }
}

function deserializePayload(event: any): any {
  return {
    ...event,
    topics: Array.isArray(event?.topics)
      ? event.topics.map((topic: unknown) => deserializeScVal(topic))
      : event?.topics,
    value: deserializeScVal(event?.value),
  }
}

interface PrismaDeadLetterRow {
  id: string
  contractId: string
  txHash: string
  eventType: string
  ledger: number
  error: string
  payload: unknown
  status: DeadLetterEventStatus
  retryCount: number
  createdAt: Date
  updatedAt: Date
}

function toDomain(row: PrismaDeadLetterRow): DeadLetterEvent {
  return {
    id: row.id,
    contractId: row.contractId,
    txHash: row.txHash,
    eventType: row.eventType,
    ledger: row.ledger,
    error: row.error,
    payload: row.payload,
    status: row.status,
    retryCount: row.retryCount,
    createdAt:
      row.createdAt instanceof Date
        ? row.createdAt.toISOString()
        : String(row.createdAt),
    updatedAt:
      row.updatedAt instanceof Date
        ? row.updatedAt.toISOString()
        : String(row.updatedAt),
  }
}

export class DeadLetterQueue {
  static async add(event: any, errorMsg: string): Promise<DeadLetterEvent> {
    const row = await (db as any).deadLetterEvent.create({
      data: {
        contractId: event?.contractId ?? 'unknown',
        txHash: event?.txHash ?? 'unknown',
        eventType: event?.type ?? 'unknown',
        ledger: typeof event?.ledger === 'number' ? event.ledger : 0,
        error: errorMsg,
        payload: serializePayload(event),
        status: 'PENDING' as const,
        retryCount: 0,
      },
    })

    const size = await this.getSize()
    logger.warn(`[DLQ] Event added to DLQ. Size: ${size}. Tx: ${row.txHash}`)
    // Update Prometheus metrics
    updateDlqSize(size)
    this.checkSizeAlert(size)
    return toDomain(row)
  }

  static async getAll(): Promise<DeadLetterEvent[]> {
    const rows: PrismaDeadLetterRow[] = await (
      db as any
    ).deadLetterEvent.findMany({
      orderBy: { createdAt: 'asc' },
    })
    return rows.map(toDomain)
  }

  static async getSize(): Promise<number> {
    return (db as any).deadLetterEvent.count()
  }

  static async retryAll(
    retryFn: (event: any) => Promise<void>
  ): Promise<{ resolved: number; failed: number }> {
    const rows: PrismaDeadLetterRow[] = await (
      db as any
    ).deadLetterEvent.findMany({
      where: { status: { in: ['PENDING', 'RETRIED'] } },
      orderBy: { createdAt: 'asc' },
    })

    let resolved = 0
    let failed = 0

    for (const row of rows) {
      try {
        await retryFn(deserializePayload(row.payload))
        await (db as any).deadLetterEvent.update({
          where: { id: row.id },
          data: { status: 'RESOLVED', retryCount: row.retryCount + 1 },
        })
        resolved++
        logger.info(`[DLQ Retry] Successfully retried event ${row.id}`)
      } catch (error) {
        await (db as any).deadLetterEvent.update({
          where: { id: row.id },
          data: { status: 'RETRIED', retryCount: row.retryCount + 1 },
        })
        failed++
        logger.error(
          `[DLQ Retry] Failed to retry event ${row.id}:`,
          error instanceof Error ? error.message : 'Unknown error'
        )
      }
    }

    logger.info(
      `[DLQ Retry] Finished. Resolved: ${resolved}, Failed: ${failed}`
    )
    // Update Prometheus metrics after retry
    const newSize = await this.getSize()
    updateDlqSize(newSize)
    return { resolved, failed }
  }

  static async resolve(id: string): Promise<boolean> {
    try {
      await (db as any).deadLetterEvent.update({
        where: { id },
        data: { status: 'RESOLVED' },
      })
      return true
    } catch {
      return false
    }
  }

  /**
   * One-shot import of any events sitting in the legacy file-backed queue.
   * Safe to call on every startup — it imports each row idempotently by
   * `(contractId, txHash, eventType, ledger, createdAt)` and then renames the
   * file to `*.migrated` so subsequent boots skip the work.
   */
  static async migrateFromLegacyFile(
    filePath: string = LEGACY_DLQ_FILE
  ): Promise<{ imported: number; skipped: number }> {
    if (!fs.existsSync(filePath)) {
      return { imported: 0, skipped: 0 }
    }

    let rows: DeadLetterEvent[] = []
    try {
      const raw = fs.readFileSync(filePath, 'utf-8')
      rows = JSON.parse(raw || '[]')
    } catch (error) {
      logger.error(
        '[DLQ] Failed to read legacy DLQ file during migration:',
        error instanceof Error ? error.message : 'Unknown error'
      )
      return { imported: 0, skipped: 0 }
    }

    let imported = 0
    let skipped = 0

    for (const event of rows) {
      const existing = await (db as any).deadLetterEvent.findFirst({
        where: {
          contractId: event.contractId,
          txHash: event.txHash,
          eventType: event.eventType,
          ledger: event.ledger,
        },
      })

      if (existing) {
        skipped++
        continue
      }

      await (db as any).deadLetterEvent.create({
        data: {
          contractId: event.contractId,
          txHash: event.txHash,
          eventType: event.eventType,
          ledger: event.ledger,
          error: event.error,
          payload: event.payload,
          status: event.status,
          retryCount: event.retryCount,
        },
      })
      imported++
    }

    try {
      fs.renameSync(filePath, `${filePath}.migrated`)
    } catch (error) {
      logger.warn(
        '[DLQ] Imported legacy DLQ rows but could not rename source file:',
        error instanceof Error ? error.message : 'Unknown error'
      )
    }

    logger.info(
      `[DLQ] Legacy file migration complete. Imported: ${imported}, Skipped (duplicate): ${skipped}`
    )
    return { imported, skipped }
  }

  private static checkSizeAlert(size: number): void {
    const threshold = config.dlq.alertThreshold

    if (size >= threshold) {
      this.emitDLQAlert(size, 'critical')
    } else if (size > 0 && size < threshold) {
      // Alert has normalized, clear the state
      alertingService.clearDLQAlertState()
    }
  }

  /**
   * Emit DLQ alert with rich metadata to external channels
   */
  private static async emitDLQAlert(
    size: number,
    severity: 'critical' | 'warning' | 'info'
  ): Promise<void> {
    try {
      // Get status breakdown
      const statusBreakdown = await this.getStatusBreakdown()
      const oldestPending = await this.getOldestPendingEvent()

      // Calculate age in human-readable format
      let ageHumanReadable = 'N/A'
      if (oldestPending) {
        const ageMs = Date.now() - new Date(oldestPending.createdAt).getTime()
        ageHumanReadable = this.formatAge(ageMs)
      }

      const payload: DLQAlertPayload = {
        title: `[CRITICAL] DLQ Size Alert: ${size} events queued`,
        description: `The Dead-Letter Queue has reached ${size} events. This indicates that recent event processing failures are not being automatically recovered. Immediate investigation required to identify and fix the root cause.`,
        severity,
        component: 'dlq',
        dlqSize: size,
        statusBreakdown,
        oldestPendingAge: oldestPending
          ? {
              eventId: oldestPending.id,
              ageMs: Date.now() - new Date(oldestPending.createdAt).getTime(),
              ageHumanReadable,
            }
          : undefined,
        adminLink: `${process.env.ADMIN_DASHBOARD_URL || 'https://admin.neurowealth.io'}/dlq`,
        metadata: {
          threshold: config.dlq.alertThreshold,
          timestamp: new Date().toISOString(),
        },
      }

      await alertingService.emitDLQAlert(payload)
    } catch (error) {
      logger.error('[DLQ] Error emitting alert:', error)
    }
  }

  /**
   * Get DLQ status breakdown (pending, retried, resolved counts)
   */
  private static async getStatusBreakdown(): Promise<{
    pending: number
    retried: number
    resolved: number
  }> {
    const pending = await (db as any).deadLetterEvent.count({
      where: { status: 'PENDING' },
    })
    const retried = await (db as any).deadLetterEvent.count({
      where: { status: 'RETRIED' },
    })
    const resolved = await (db as any).deadLetterEvent.count({
      where: { status: 'RESOLVED' },
    })

    return { pending, retried, resolved }
  }

  /**
   * Get the oldest pending event (for age tracking)
   */
  private static async getOldestPendingEvent(): Promise<PrismaDeadLetterRow | null> {
    return (db as any).deadLetterEvent.findFirst({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
    })
  }

  /**
   * Format milliseconds to human-readable age (e.g., "2 hours 15 minutes")
   */
  private static formatAge(ms: number): string {
    const seconds = Math.floor(ms / 1000)
    const minutes = Math.floor(seconds / 60)
    const hours = Math.floor(minutes / 60)
    const days = Math.floor(hours / 24)

    if (days > 0) {
      return `${days} day${days > 1 ? 's' : ''} ${hours % 24} hour${hours % 24 !== 1 ? 's' : ''}`
    }
    if (hours > 0) {
      return `${hours} hour${hours > 1 ? 's' : ''} ${minutes % 60} minute${minutes % 60 !== 1 ? 's' : ''}`
    }
    if (minutes > 0) {
      return `${minutes} minute${minutes > 1 ? 's' : ''}`
    }
    return `${seconds} second${seconds !== 1 ? 's' : ''}`
  }
}
