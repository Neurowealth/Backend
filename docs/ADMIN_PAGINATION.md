# Admin List Endpoints — Pagination Inventory (#612)

This document is the authoritative inventory of admin list endpoints and the
pagination style each uses. "Hot" endpoints — the ones that read large,
write-heavy tables — must use cursor pagination so a reader paging through a
timeline is not shifted by concurrent inserts. "Cold" endpoints over small
bounded sets may keep offset pagination because the UI needs page-number
jumps.

The utilities both styles share live in `src/utils/pagination.ts`.

## Why cursor beats offset for hot admin reads

Offset pagination (`?page=43`) issues `OFFSET 42*limit` under the hood: the
database scans the whole prefix, which degrades to a full table scan on large
tables, **and** a single concurrent INSERT on a page the reader has already
turned shifts every subsequent row's index by one. A reader doing a sweep then
either sees a row twice (an INSERT shrank the window) or misses one (a DELETE
grew it). Cursor pagination names an exact row (`createdAt, id`) as the
anchor, so a page returned after a concurrent write still describes "the
next 25 rows strictly older than this one," never "whichever rows now occupy
positions 1050–1074."

## Inventory

| Endpoint                                   | File                               | Style  | Notes                                                                             |
|--------------------------------------------|------------------------------------|--------|-----------------------------------------------------------------------------------|
| `GET /api/admin/dlq/inspect`               | `src/routes/admin.ts`              | custom | Filters + in-memory slice over the full DLQ (bounded by alert threshold). Fine.   |
| `GET /api/admin/rebalance/decisions`       | `src/routes/admin.ts`              | offset | **Hot** (audit of every rebalance). Migrate — large, write-heavy, timestamp-ordered. |
| `GET /api/admin/messages/*`                | messaging admin                    | varies | Delivery log; large and growing. Migrate on next edit.                            |
| `GET /api/admin/support/tickets`           | `src/routes/admin/support-tickets.ts` | none   | Returns the whole set, no pagination. Bounded by SLA window; cursor on next edit. |
| `GET /api/admin/risk/protocols`            | `src/routes/admin/risk-metadata.ts`| none   | Small bounded set (one row per protocol). Keep.                                   |
| Audit logs (`AdminAuditLog.findMany`)      | various                            | varies | **Hot**. Any new reader must cursor-paginate.                                     |
| Webhook deliveries                         | webhook admin                      | varies | **Hot**. Migrate on next edit.                                                    |
| Erasure requests                           | privacy admin                      | offset | Bounded by legal timescales. Fine for now.                                        |

Migration guidance: use the helpers in `src/utils/pagination.ts` —
`cursorPaginationSchema`, `buildCursorQuery`, `sliceCursorPage` — and verify
with the stability test `tests/unit/utils/cursorPagination.test.ts` as the
template. Keep the offset variant exposed under a different query shape when
the UI genuinely needs page-number jumps (bounded, non-paging-sensitive).

## Standard shape

A cursor-paginated response looks like:

```json
{
  "items": [ { "id": "...", "createdAt": "...", "...": "..." } ],
  "nextCursor": "eyJjcmVhdGVkQXQi...",
  "hasMore": true
}
```

Request:

```
GET /api/admin/things?cursor=<opaque>&limit=25
```

- `cursor` is opaque; clients must not parse it or construct it.
- `limit` is capped at 100.
- A missing `cursor` means "start from the newest."
- `nextCursor === null` means the reader has reached the oldest row that
  existed when their last request landed. Fresher rows that arrived
  afterwards are visible on a new `cursor-less` request.

## Order and tiebreaker

The sort key is **`(createdAt DESC, id DESC)`**. The id tiebreaker matters for
rows that share a millisecond timestamp (common on bulk ingests) — without
it, the cursor would be ambiguous and pages would skip.

## Backwards and forwards

`direction: 'backward'` reverses both the sort and the comparison predicate,
so a caller walking a timeline backwards sees pages in the same display
order. Most readers do not need this; it is included for parity with
infinite-scroll UIs that let a user scroll past the top.
