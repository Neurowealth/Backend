/**
 * Cursor pagination unit tests (#612).
 *
 * The guarantee we care about most is **stability under concurrent inserts**:
 * if a reader walks `page 1 → page 2 → …` and new rows arrive between
 * requests, no row should appear twice and no row within the already-walked
 * window should be missed. Offset pagination fails this; a `(createdAt, id)`
 * cursor passes it because the cursor names an exact row rather than a
 * position.
 */

import {
  buildCursorQuery,
  decodeCursor,
  encodeCursor,
  sliceCursorPage,
  cursorPaginationSchema,
} from '../../../src/utils/pagination'

interface Row {
  id: string
  createdAt: Date
  label: string
}

const T = (iso: string) => new Date(iso)

function sortDesc(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => {
    const d = b.createdAt.getTime() - a.createdAt.getTime()
    if (d !== 0) return d
    return b.id.localeCompare(a.id)
  })
}

/** Simulate `prisma.findMany({ where, orderBy, take })` against an array. */
function simulateFindMany(
  rows: Row[],
  query: ReturnType<typeof buildCursorQuery>
): Row[] {
  const sorted = sortDesc(rows)
  const filtered = sorted.filter((r) => {
    const where = query.where
    if (!where.OR) return true
    const or = where.OR as any[]
    const createdAtLt = or[0].createdAt.lt
    const anchorCreatedAt = or[1].AND[0].createdAt
    const anchorIdLt = or[1].AND[1].id.lt
    if (r.createdAt < createdAtLt) return true
    if (
      r.createdAt.getTime() === anchorCreatedAt.getTime() &&
      r.id < anchorIdLt
    )
      return true
    return false
  })
  return filtered.slice(0, query.take)
}

describe('cursor encoding (#612)', () => {
  it('round-trips createdAt and id through base64url', () => {
    const row = { id: 'row-abc', createdAt: T('2026-10-21T12:00:00.000Z') }
    const encoded = encodeCursor(row)!
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
    const decoded = decodeCursor(encoded)!
    expect(decoded.id).toBe('row-abc')
    expect(decoded.createdAt.toISOString()).toBe('2026-10-21T12:00:00.000Z')
  })

  it('encodes a null row as null', () => {
    expect(encodeCursor(null)).toBeNull()
    expect(encodeCursor(undefined)).toBeNull()
  })

  it('decodes a missing cursor as null (no filter)', () => {
    expect(decodeCursor(undefined)).toBeNull()
    expect(decodeCursor(null)).toBeNull()
    expect(decodeCursor('')).toBeNull()
  })

  it('rejects malformed cursors', () => {
    expect(() => decodeCursor('not-base64url')).toThrow()
    expect(() =>
      decodeCursor(Buffer.from('no-separator').toString('base64url'))
    ).toThrow()
    expect(() =>
      decodeCursor(Buffer.from('|only-id').toString('base64url'))
    ).toThrow()
  })
})

describe('cursorPaginationSchema (#612)', () => {
  it('applies defaults', () => {
    const parsed = cursorPaginationSchema.parse({})
    expect(parsed).toEqual({ limit: 25, direction: 'forward' })
  })

  it('clamps limit to 100', () => {
    expect(() => cursorPaginationSchema.parse({ limit: 101 })).toThrow()
  })

  it('rejects a limit below 1', () => {
    expect(() => cursorPaginationSchema.parse({ limit: 0 })).toThrow()
  })
})

describe('sliceCursorPage (#612)', () => {
  const rows: Row[] = Array.from({ length: 5 }, (_, i) => ({
    id: `row-${i}`,
    createdAt: T(`2026-10-21T12:00:0${4 - i}.000Z`),
    label: `label-${i}`,
  }))

  it('with fewer rows than the limit, returns everything with no nextCursor', () => {
    const { items, nextCursor, hasMore } = sliceCursorPage(rows, 10)
    expect(items).toEqual(rows)
    expect(nextCursor).toBeNull()
    expect(hasMore).toBe(false)
  })

  it('with exactly limit+1 rows, returns limit and a nextCursor to the last returned row', () => {
    const { items, nextCursor, hasMore } = sliceCursorPage(rows, 4)
    expect(items).toHaveLength(4)
    expect(nextCursor).toBeTruthy()
    expect(hasMore).toBe(true)
    expect(decodeCursor(nextCursor)!.id).toBe('row-3')
  })
})

describe('cursor stability under concurrent inserts (#612)', () => {
  /**
   * The reader's walk: ask for page 1 (3 rows), then page 2 using the next
   * cursor. Between the two requests a writer inserts two brand-new rows at
   * the head of the timeline. The reader must still see the exact ten
   * original rows across the two pages — no duplicates, no misses.
   */
  it('a reader paging through sees every original row exactly once', () => {
    const original: Row[] = Array.from({ length: 10 }, (_, i) => ({
      id: `old-${String(i).padStart(2, '0')}`,
      createdAt: T(`2026-10-21T12:00:${String(i).padStart(2, '0')}.000Z`),
      label: `old-${i}`,
    }))

    // Page 1
    const q1 = buildCursorQuery({ limit: 3, direction: 'forward' })
    const page1Rows = simulateFindMany(original, q1)
    const { items: page1, nextCursor } = sliceCursorPage(page1Rows, 3)
    expect(page1.map((r) => r.id)).toEqual(['old-09', 'old-08', 'old-07'])

    // Concurrent writes: two brand-new rows arrive at the HEAD of the timeline.
    const afterWrites: Row[] = [
      ...original,
      {
        id: 'new-01',
        createdAt: T('2026-10-21T12:10:00.000Z'),
        label: 'new-01',
      },
      {
        id: 'new-02',
        createdAt: T('2026-10-21T12:10:01.000Z'),
        label: 'new-02',
      },
    ]

    // Page 2 with the cursor from page 1 — anchored on 'old-07'.
    const q2 = buildCursorQuery({
      cursor: nextCursor!,
      limit: 3,
      direction: 'forward',
    })
    const page2Rows = simulateFindMany(afterWrites, q2)
    const { items: page2, nextCursor: cursor3 } = sliceCursorPage(page2Rows, 3)
    expect(page2.map((r) => r.id)).toEqual(['old-06', 'old-05', 'old-04'])

    // Walk the rest.
    const q3 = buildCursorQuery({
      cursor: cursor3!,
      limit: 10,
      direction: 'forward',
    })
    const page3Rows = simulateFindMany(afterWrites, q3)
    const { items: page3 } = sliceCursorPage(page3Rows, 10)
    expect(page3.map((r) => r.id)).toEqual([
      'old-03',
      'old-02',
      'old-01',
      'old-00',
    ])

    const seen = new Set([...page1, ...page2, ...page3].map((r) => r.id))
    expect(seen.size).toBe(original.length)
    for (const r of original) expect(seen.has(r.id)).toBe(true)
    // The new rows are deliberately NOT in the already-walked window — the
    // reader can see them on a future page-1 request when they refresh.
    expect(seen.has('new-01')).toBe(false)
    expect(seen.has('new-02')).toBe(false)
  })

  it('ties on createdAt are broken by id so the cursor still advances', () => {
    const same = T('2026-10-21T12:00:00.000Z')
    const rows: Row[] = ['a', 'b', 'c', 'd', 'e'].map((id) => ({
      id,
      createdAt: same,
      label: id,
    }))

    const q1 = buildCursorQuery({ limit: 2, direction: 'forward' })
    const page1Rows = simulateFindMany(rows, q1)
    const { items: page1, nextCursor } = sliceCursorPage(page1Rows, 2)
    expect(page1.map((r) => r.id)).toEqual(['e', 'd'])

    const q2 = buildCursorQuery({
      cursor: nextCursor!,
      limit: 2,
      direction: 'forward',
    })
    const page2Rows = simulateFindMany(rows, q2)
    const { items: page2 } = sliceCursorPage(page2Rows, 2)
    expect(page2.map((r) => r.id)).toEqual(['c', 'b'])
  })
})
