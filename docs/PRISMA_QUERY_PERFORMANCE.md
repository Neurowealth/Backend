# Prisma Hot-Query Profiling

The hot-path review traced these Prisma reads to their SQL access shapes:

| Query                                                  | Filter/order/limit shape                                                                             | Supporting index                                              |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| User webhook delivery history (`listDeliveries`)       | `endpointId = ? ORDER BY createdAt DESC LIMIT 50`                                                    | `user_webhook_deliveries(endpointId, createdAt)`              |
| Outbound webhook recent failures (subscription health) | `subscriptionId = ? AND status = FAILED AND createdAt >= ?`                                          | `webhook_deliveries(subscriptionId, status, createdAt)`       |
| Outbound dead-letter replay                            | `subscriptionId = ? AND status = PENDING AND firstFailedAt >= ? ORDER BY firstFailedAt ASC LIMIT 50` | `webhook_dead_letters(subscriptionId, status, firstFailedAt)` |

Existing indexes covered individual endpoint/createdAt columns or the
dead-letter `(subscriptionId, status)` prefix, but not the full ordering/range
paths. The composite indexes are built with `CONCURRENTLY` so writes can
continue during index creation.

## Regression and Profiling Check

After applying migrations to a representative PostgreSQL database, run:

```sh
PERF_PROFILE_ENDPOINT_ID=<endpoint-id> \
PERF_PROFILE_SUBSCRIPTION_ID=<subscription-id> \
npm run profile:hot-queries
```

The check fails if any expected index is absent, emits `EXPLAIN ANALYZE` plans
and buffer counts for the three production query shapes, and requires the
expected index to appear in the plan when PostgreSQL estimates at least
`PERF_MIN_ROWS_FOR_INDEX_ASSERTION` rows (default `10000`). On smaller tables,
the index catalog check still runs and the plan is reported without forcing a
possibly slower index scan. Set the profile IDs to representative active rows
when comparing plans between releases. The local workspace did not have a
PostgreSQL server available during this review, so actual before/after plan
times must be captured in staging or another representative database.
