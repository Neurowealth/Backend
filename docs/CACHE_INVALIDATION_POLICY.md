# User cache invalidation policy (#514)

Redis caching is an optional, best-effort optimization. PostgreSQL remains authoritative.
Authentication and authorization must never rely on cached profile or conversation data.
These helpers provide bounded-age caching and eviction, **not zero stale reads or
transactional consistency between PostgreSQL and Redis**.

## Keys and readers

| Key                                   | Format and lifetime                                                    | Reader behavior                                                                                                                                                         |
| ------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `portfolio_snapshot:<userId>`         | Version 1 envelope; `PORTFOLIO_CACHE_TTL_SECONDS` (default 60 seconds) | Portfolio helpers validate the envelope and return null on stale/missing data so callers can read the database. Current portfolio HTTP routes read PostgreSQL directly. |
| `user_profile:<userId>`               | Reserved key; no production profile cache reader/writer currently      | Mutations evict this key defensively. Do not cache authentication decisions here.                                                                                       |
| `assistant:memory:<channel>:<userId>` | Version 1 envelope, 1,800 seconds, at most 20 turns                    | Assistant reads reject stale/malformed envelopes and start with empty history on a miss.                                                                                |

Assistant channels are `whatsapp`, `telegram`, and `api`. Full invalidation also
removes legacy `web` keys. Old raw portfolio or conversation values are evicted
on first read; conversation history may reset once during rollout.

## Validation

`validateOrInvalidateCache` validates a non-null payload, finite positive `cachedAt`,
maximum age (defaulting to TTL), exact requested schema version, optional authoritative
`updatedAt`, and an optional payload validator. Future timestamps, missing versions when
required, malformed timestamps, and failed validators are misses. No stale response is
used when the primary loader fails; that error propagates.

On a miss, stale data is evicted and the loader runs. Non-null results are stored with
a timestamp captured before loading. Redis read/write/delete errors do not prevent
returning primary-store data. TTL must be positive to write a new entry.

## Mutation hooks

- Transaction controller dispatch outcomes evict portfolio snapshots after updating the transaction.
- Outbox definitive outcomes (including background confirmation, retries, and reconciliation)
  evict the linked transaction owner's portfolio after mirroring its status.
- Deposit/withdrawal event processing evicts the position owner's portfolio; batch processing
  defers eviction until the enclosing database transaction commits.
- Notification preference and assistant strategy updates evict profile keys after persistence.
- Account anonymization clears all user caches after the user update.
- Session revocation clears all user keys using the persisted session owner, including logout,
  administrator revocation, anomaly revocation, and refresh-token reuse. Local sockets close
  before waiting for Redis. Successful refresh rotation alone does not clear caches.

## Consistency limits

A concurrent reader can refill a key after eviction. A failed Redis deletion can leave an
old entry available until its TTL or age limit expires, including after Redis recovers.
Clock skew can cause conservative misses. These operations are not a distributed transaction
or a durable invalidation queue, and do not establish read-after-write consistency across pods.
Cache deletion logs indicate attempts, not proof of successful Redis deletion.

Keep financial and security decisions on authoritative database reads. Callers requiring
stronger consistency need a database revision checked on every read and atomic generation-aware
cache writes, or should bypass the cache. Do not advertise this implementation as eliminating
all stale reads. The number of deleted keys is fixed; payload validation/serialization and
Redis memory usage scale with payload size.

## Verification

```bash
npm test -- --runInBand --watchman=false tests/unit/utils/user-cache-invalidation.test.ts tests/unit/utils/user-cache-readers.test.ts tests/unit/outbox/cache-invalidation.test.ts tests/unit/auth/refresh-token.service.test.ts
npm run typecheck
npm run lint
```
