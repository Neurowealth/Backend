import { z } from 'zod'

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})

export interface PaginationMeta {
  page: number
  limit: number
  total: number
  totalPages: number
  hasNext: boolean
  hasPrevious: boolean
}

export function getPaginationParams(query: {
  page?: unknown
  limit?: unknown
}) {
  const parsed = paginationSchema.parse(query)
  const { page, limit } = parsed
  const skip = (page - 1) * limit
  return { page, limit, skip }
}

export function buildPaginationMeta(
  page: number,
  limit: number,
  total: number
): PaginationMeta {
  const totalPages = Math.ceil(total / limit)
  return {
    page,
    limit,
    total,
    totalPages,
    hasNext: page < totalPages,
    hasPrevious: page > 1 && totalPages > 0,
  }
}

// ── Cursor pagination (#612) ────────────────────────────────────────────────
//
// Hot admin list endpoints (audit logs, transactions, deliveries) outgrew
// offset pagination: deep pages (`skip=10000`) scan the whole prefix and a
// concurrent INSERT on a page already turned shifts every subsequent row by
// one, so a reader paging through either sees a row twice or misses one.
//
// The replacement is a composite `(createdAt, id)` cursor. `createdAt` orders
// rows the way a reader expects a timeline to flow; `id` is the tiebreaker
// that makes the cursor stable across rows that share a timestamp. The
// cursor itself is opaque base64url — callers do not parse it.

export interface CursorRow {
  id: string
  createdAt: Date
}

export const cursorPaginationSchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  direction: z.enum(['forward', 'backward']).default('forward'),
})

export type CursorPaginationParams = z.infer<typeof cursorPaginationSchema>

/**
 * Encode a `(createdAt, id)` tuple as an opaque, caller-safe cursor.
 * Null-safe: `encodeCursor(null)` returns null so callers can hand through a
 * "no next page" result without a branch.
 */
export function encodeCursor(row: CursorRow | null | undefined): string | null {
  if (!row) return null
  const payload = `${row.createdAt.toISOString()}|${row.id}`
  return Buffer.from(payload, 'utf8').toString('base64url')
}

/**
 * Decode an opaque cursor back into its `(createdAt, id)` tuple. Returns
 * null for a missing cursor and throws for malformed input — callers should
 * catch and map to a 400.
 */
export function decodeCursor(
  cursor: string | undefined | null
): CursorRow | null {
  if (!cursor) return null
  const payload = Buffer.from(cursor, 'base64url').toString('utf8')
  const sep = payload.indexOf('|')
  if (sep < 1) throw new Error('invalid_cursor')
  const createdAtRaw = payload.slice(0, sep)
  const id = payload.slice(sep + 1)
  const createdAt = new Date(createdAtRaw)
  if (Number.isNaN(createdAt.getTime()) || !id) {
    throw new Error('invalid_cursor')
  }
  return { id, createdAt }
}

export interface PrismaCursorQuery {
  /** Pass directly into Prisma `where` to merge with existing filters. */
  where: Record<string, unknown>
  /** Pass directly into Prisma `orderBy`. */
  orderBy: Array<Record<string, 'asc' | 'desc'>>
  /** Pass as `take` — the caller fetches `limit + 1` to detect `hasMore`. */
  take: number
}

/**
 * Build the Prisma fragments that execute a cursor-paginated query. Use with:
 *
 *   const q = buildCursorQuery({ cursor, limit })
 *   const rows = await db.foo.findMany({ ...q, where: { ...q.where, ...myFilters } })
 *   const { items, nextCursor } = sliceCursorPage(rows, limit)
 *
 * `direction: 'backward'` reverses the order and the comparison predicate so
 * a caller walking a timeline backwards sees pages in the same display order.
 */
export function buildCursorQuery(
  params: CursorPaginationParams
): PrismaCursorQuery {
  const { cursor, limit, direction } = params
  const anchor = decodeCursor(cursor)
  const dir: 'asc' | 'desc' = direction === 'forward' ? 'desc' : 'asc'
  const cmp = direction === 'forward' ? 'lt' : 'gt'

  const where: Record<string, unknown> = {}
  if (anchor) {
    // (createdAt < anchor.createdAt) OR (createdAt == anchor.createdAt AND id < anchor.id)
    where.OR = [
      { createdAt: { [cmp]: anchor.createdAt } },
      {
        AND: [{ createdAt: anchor.createdAt }, { id: { [cmp]: anchor.id } }],
      },
    ]
  }

  return {
    where,
    orderBy: [{ createdAt: dir }, { id: dir }],
    take: limit + 1,
  }
}

/**
 * Slice a result array fetched with `limit + 1` into the page the caller
 * returns and the cursor pointing at the next page (or null if the last row
 * fits).
 */
export function sliceCursorPage<T extends CursorRow>(
  rows: T[],
  limit: number
): { items: T[]; nextCursor: string | null; hasMore: boolean } {
  const hasMore = rows.length > limit
  const items = hasMore ? rows.slice(0, limit) : rows
  const nextCursor = hasMore ? encodeCursor(items[items.length - 1]) : null
  return { items, nextCursor, hasMore }
}
