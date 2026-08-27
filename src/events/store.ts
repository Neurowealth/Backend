/**
 * Durable per-user event stream (#316).
 *
 * See the DESIGN NOTE on `model UserEvent` in prisma/schema.prisma for why this
 * is Postgres and not a Redis stream. In short: Redis is optional in this
 * deployment, so a Redis-only stream would make `resume afterSeq` unavailable
 * in the most common configuration, and would put durability on a store we
 * treat everywhere else as a cache.
 *
 * `seq` values are exposed to the rest of the process as `number`. Postgres
 * hands them back as `bigint` (Prisma maps BIGINT that way); a per-user counter
 * would have to pass 2^53 events before that conversion could lose precision,
 * which at the platform's busiest plausible rate is longer than the heat death
 * of the product. Converting at this boundary keeps JSON.stringify working for
 * every frame — bigint is not JSON-serialisable.
 */

import db from '../db'
import { logger } from '../utils/logger'
import type { UserEventTopic, UserEventType } from './types'

/** One row of the durable stream, as the rest of the process sees it. */
export interface StoredUserEvent {
  seq: number
  topic: UserEventTopic
  type: UserEventType
  payload: Record<string, unknown>
  emittedAt: string
}

/** How many events a single replay may return. Bounds a hostile `afterSeq: 0`. */
export const REPLAY_PAGE_LIMIT = Math.max(
  1,
  parseInt(process.env.WS_REPLAY_MAX_EVENTS || '1000', 10)
)

/**
 * Append an event to a user's stream and return its allocated sequence number.
 *
 * The counter increment and the row INSERT run in one transaction. The
 * increment is a single `INSERT … ON CONFLICT DO UPDATE … RETURNING`, so
 * concurrent publishers for the same user serialise on that row's lock: no
 * duplicate seq, and — because the number is allocated and consumed inside the
 * same transaction — no hole either. A hole would be worse than a duplicate;
 * a client waiting for the missing seq would stall forever.
 *
 * `payload` must already be redacted (see mapUserEventPayloadToResponse). The
 * store is not a second chance to strip fields: a replay reads straight out of
 * here, so whatever is written is what a client eventually sees.
 */
export async function appendUserEvent(params: {
  userId: string
  topic: UserEventTopic
  type: UserEventType
  payload: Record<string, unknown>
}): Promise<StoredUserEvent> {
  const { userId, topic, type, payload } = params

  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ lastSeq: bigint }>>`
      INSERT INTO "user_event_sequences" ("userId", "lastSeq", "updatedAt")
      VALUES (${userId}, 1, NOW())
      ON CONFLICT ("userId") DO UPDATE
        SET "lastSeq" = "user_event_sequences"."lastSeq" + 1,
            "updatedAt" = NOW()
      RETURNING "lastSeq"
    `

    const seq = Number(rows[0].lastSeq)

    const row = await tx.userEvent.create({
      data: { userId, seq, topic, type, payload: payload as object },
      select: {
        seq: true,
        topic: true,
        type: true,
        payload: true,
        createdAt: true,
      },
    })

    return {
      seq: Number(row.seq),
      topic: row.topic as UserEventTopic,
      type: row.type as UserEventType,
      payload: (row.payload ?? {}) as Record<string, unknown>,
      emittedAt: row.createdAt.toISOString(),
    }
  })
}

/** Newest seq allocated for a user, or 0 when they have never had an event. */
export async function getLatestSeq(userId: string): Promise<number> {
  const row = await db.userEventSequence.findUnique({
    where: { userId },
    select: { lastSeq: true },
  })
  return row ? Number(row.lastSeq) : 0
}

/** Oldest seq still replayable, or null once retention has emptied the stream. */
export async function getOldestAvailableSeq(
  userId: string
): Promise<number | null> {
  const row = await db.userEvent.findFirst({
    where: { userId },
    orderBy: { seq: 'asc' },
    select: { seq: true },
  })
  return row ? Number(row.seq) : null
}

/**
 * Read up to `limit` events after `afterSeq`, oldest first, restricted to
 * `topics`.
 *
 * Topic filtering happens in SQL rather than in the caller so a client
 * subscribed to one quiet topic cannot make the server page through another
 * topic's storm to find it.
 */
export async function readAfterSeq(params: {
  userId: string
  afterSeq: number
  topics: UserEventTopic[]
  limit?: number
}): Promise<StoredUserEvent[]> {
  const { userId, afterSeq, topics } = params
  const limit = Math.min(params.limit ?? REPLAY_PAGE_LIMIT, REPLAY_PAGE_LIMIT)

  if (topics.length === 0) return []

  const rows = await db.userEvent.findMany({
    where: { userId, seq: { gt: afterSeq }, topic: { in: topics } },
    orderBy: { seq: 'asc' },
    take: limit,
    select: {
      seq: true,
      topic: true,
      type: true,
      payload: true,
      createdAt: true,
    },
  })

  return rows.map((row) => ({
    seq: Number(row.seq),
    topic: row.topic as UserEventTopic,
    type: row.type as UserEventType,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    emittedAt: row.createdAt.toISOString(),
  }))
}

/**
 * Trim any user whose stream exceeds `maxPerUser` rows, keeping the newest.
 *
 * Complements the age-based sweep in src/jobs/dataRetention.ts: age alone lets
 * one pathological account grow without bound inside the retention window, and
 * the whole point of a bounded stream is that no single user can do that.
 * Returns the number of rows deleted.
 */
export async function trimUserEventStreams(
  maxPerUser: number
): Promise<number> {
  if (maxPerUser <= 0) return 0

  try {
    // One statement: for every user over the cap, delete everything below the
    // seq of their `maxPerUser`-th newest event. Doing this per-user in JS
    // would be a query per account on a table that only ever grows.
    const result = await db.$executeRaw`
      DELETE FROM "user_events" ue
      USING (
        SELECT "userId", "seq" AS cutoff
        FROM (
          SELECT "userId",
                 "seq",
                 ROW_NUMBER() OVER (PARTITION BY "userId" ORDER BY "seq" DESC) AS rn
          FROM "user_events"
        ) ranked
        WHERE ranked.rn = ${maxPerUser}
      ) keep
      WHERE ue."userId" = keep."userId" AND ue."seq" < keep.cutoff
    `
    return result
  } catch (error) {
    logger.error('[UserEventStore] Stream trim failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return 0
  }
}
