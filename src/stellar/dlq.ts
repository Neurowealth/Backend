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

const SIZE_ALERT_THRESHOLD = 50

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
    if (size >= SIZE_ALERT_THRESHOLD) {
      logger.error(
        `[DLQ ALERT] Dead-letter queue size is critically high: ${size} events. Manual intervention required.`
      )
    }
  }
}
