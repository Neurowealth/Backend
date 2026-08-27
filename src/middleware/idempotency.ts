import { createHash } from 'node:crypto'
import type { Request, Response, NextFunction } from 'express'
import db from '../db'
import { getRedisClient } from '../config/redis'
import { logger } from '../utils/logger'

const prisma = db as any

export interface IdempotencyOptions {
  /** TTL for completed records in seconds (default 24h). */
  ttlSeconds?: number
  /** Require Idempotency-Key header (money routes). */
  required?: boolean
  /** Fail closed when Redis+DB both unavailable (money routes). */
  failClosed?: boolean
}

interface IdempotencyRecord {
  fingerprint: string
  status: 'in_progress' | 'completed'
  statusCode?: number
  responseBody?: unknown
  completedAt?: string
}

const LOCK_TTL_MS = 30_000
const IDEM_MAX_BODY_BYTES = parseInt(process.env.IDEM_MAX_BODY_BYTES || '65536')

function redisKey(userId: string, key: string): string {
  return `idem:${userId}:${key}`
}

function canonicalizeBody(body: unknown): string {
  if (body === null || body === undefined) return ''
  if (typeof body !== 'object') return JSON.stringify(body)
  const sorted = sortKeys(body as Record<string, unknown>)
  return JSON.stringify(sorted)
}

function sortKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(obj).sort()) {
    const val = obj[key]
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      result[key] = sortKeys(val as Record<string, unknown>)
    } else {
      result[key] = val
    }
  }
  return result
}

function computeFingerprint(req: Request, userId: string): string {
  const body = canonicalizeBody(req.body)
  const raw = `${req.method}:${req.path}:${userId}:${body}`
  return createHash('sha256').update(raw).digest('hex')
}

async function getDbRecord(
  userId: string,
  key: string
): Promise<IdempotencyRecord | null> {
  try {
    const row = await prisma.idempotencyRecord.findUnique({
      where: { userId_idempotencyKey: { userId, idempotencyKey: key } },
    })
    if (!row) return null
    if (row.expiresAt <= new Date()) return null
    return {
      fingerprint: row.fingerprint,
      status: row.status as 'in_progress' | 'completed',
      statusCode: row.statusCode ?? undefined,
      responseBody: row.responseBody ?? undefined,
      completedAt: row.completedAt?.toISOString(),
    }
  } catch {
    return null
  }
}

async function persistDbRecord(
  userId: string,
  key: string,
  record: IdempotencyRecord,
  ttlSeconds: number
): Promise<void> {
  try {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000)
    await prisma.idempotencyRecord.upsert({
      where: { userId_idempotencyKey: { userId, idempotencyKey: key } },
      create: {
        userId,
        idempotencyKey: key,
        fingerprint: record.fingerprint,
        status: record.status,
        statusCode: record.statusCode ?? null,
        responseBody: record.responseBody ?? null,
        completedAt: record.completedAt ? new Date(record.completedAt) : null,
        expiresAt,
      },
      update: {
        fingerprint: record.fingerprint,
        status: record.status,
        statusCode: record.statusCode ?? null,
        responseBody: record.responseBody ?? null,
        completedAt: record.completedAt ? new Date(record.completedAt) : null,
        expiresAt,
      },
    })
  } catch (err) {
    logger.warn('[Idempotency] DB persist failed', { err })
  }
}

/**
 * Stripe-style idempotency middleware (#375).
 *
 * Dedupes retried mutating requests by client-supplied Idempotency-Key header.
 */
export function idempotent(options: IdempotencyOptions = {}) {
  const ttlSeconds = options.ttlSeconds ?? 86400
  const required = options.required ?? false
  const failClosed = options.failClosed ?? false

  return async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    const idempotencyKey = req.header('Idempotency-Key')?.trim()

    if (!idempotencyKey) {
      if (required) {
        res.status(400).json({ error: 'idempotency_key_required' })
        return
      }
      next()
      return
    }

    if (idempotencyKey.length > 255) {
      res.status(400).json({ error: 'idempotency_key_too_long' })
      return
    }

    const userId = req.auth?.userId ?? req.userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    const fingerprint = computeFingerprint(req, userId)
    const rKey = redisKey(userId, idempotencyKey)
    const redis = getRedisClient()

    let existing: IdempotencyRecord | null = null

    if (redis) {
      try {
        const raw = await redis.get(rKey)
        if (raw) existing = JSON.parse(raw) as IdempotencyRecord
      } catch (err) {
        logger.warn('[Idempotency] Redis get failed', { err })
      }
    }

    if (!existing) {
      existing = await getDbRecord(userId, idempotencyKey)
    }

    if (existing) {
      if (existing.status === 'in_progress') {
        res.status(409).json({ error: 'idempotency_request_in_flight' })
        return
      }
      if (existing.fingerprint !== fingerprint) {
        res.status(422).json({ error: 'idempotency_key_reuse' })
        return
      }
      if (existing.statusCode !== undefined) {
        res.setHeader('Idempotency-Replayed', 'true')
        res.status(existing.statusCode).json(existing.responseBody)
        return
      }
    }

    // Acquire lock
    let lockAcquired = false
    if (redis) {
      try {
        const result = await redis.set(
          rKey,
          JSON.stringify({ fingerprint, status: 'in_progress' }),
          'PX',
          LOCK_TTL_MS,
          'NX'
        )
        lockAcquired = result === 'OK'
      } catch (err) {
        logger.warn('[Idempotency] Redis lock failed', { err })
      }
    } else if (failClosed) {
      res.status(503).json({ error: 'Idempotency store unavailable' })
      return
    } else {
      lockAcquired = true
    }

    if (!lockAcquired && redis) {
      const retry = await redis.get(rKey)
      if (retry) {
        const parsed = JSON.parse(retry) as IdempotencyRecord
        if (
          parsed.status === 'completed' &&
          parsed.fingerprint === fingerprint
        ) {
          res.setHeader('Idempotency-Replayed', 'true')
          res.status(parsed.statusCode ?? 200).json(parsed.responseBody)
          return
        }
      }
      res.status(409).json({ error: 'idempotency_request_in_flight' })
      return
    }

    const originalJson = res.json.bind(res)
    res.json = (body: unknown) => {
      const statusCode = res.statusCode
      const bodyStr = JSON.stringify(body)
      const record: IdempotencyRecord = {
        fingerprint,
        status: 'completed',
        statusCode,
        responseBody:
          bodyStr.length <= IDEM_MAX_BODY_BYTES
            ? body
            : { message: 'already_processed', fetchCurrentState: true },
        completedAt: new Date().toISOString(),
      }

      if (redis) {
        redis
          .set(rKey, JSON.stringify(record), 'EX', ttlSeconds)
          .catch((err) =>
            logger.warn('[Idempotency] Redis store failed', { err })
          )
      }
      persistDbRecord(userId, idempotencyKey, record, ttlSeconds)

      return originalJson(body)
    }

    next()
  }
}
