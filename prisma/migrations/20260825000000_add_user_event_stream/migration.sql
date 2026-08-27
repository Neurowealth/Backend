-- Migration: add_user_event_stream (#316)
-- Durable, sequence-numbered per-user event stream backing the authenticated
-- WebSocket transport (/api/v1/ws) and its `resume afterSeq` replay.
--
-- Why Postgres rather than a Redis stream: REDIS_URL is optional (see
-- src/config/redis.ts, which degrades to a no-op), so a Redis-only stream would
-- make replay unavailable in the most common configuration. Redis remains the
-- cross-pod transport only — never the store.

-- Per-user monotonic counter. One row per user; the publisher increments it
-- with INSERT … ON CONFLICT DO UPDATE … RETURNING so concurrent publishers
-- serialise on the row lock and cannot mint duplicate or skipped sequences.
CREATE TABLE "user_event_sequences" (
    "userId"    TEXT NOT NULL,
    "lastSeq"   BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_event_sequences_pkey" PRIMARY KEY ("userId")
);

ALTER TABLE "user_event_sequences"
    ADD CONSTRAINT "user_event_sequences_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The stream itself. `payload` is stored already-redacted (see the per-type
-- allowlists in src/utils/api-formatters.ts) so a replay can never hand a
-- client a field the live path would have stripped.
CREATE TABLE "user_events" (
    "id"        TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "seq"       BIGINT NOT NULL,
    "topic"     TEXT NOT NULL,
    "type"      TEXT NOT NULL,
    "payload"   JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_events_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "user_events"
    ADD CONSTRAINT "user_events_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Gaplessness is enforced by the counter, but the unique index is the backstop:
-- a second writer that somehow reused a seq fails its INSERT rather than
-- silently corrupting a replay.
CREATE UNIQUE INDEX "user_events_userId_seq_key" ON "user_events"("userId", "seq");

-- Replay reads are always "WHERE userId = ? AND seq > ? ORDER BY seq ASC LIMIT n".
CREATE INDEX "user_events_userId_seq_idx" ON "user_events"("userId", "seq");

-- Age-based retention sweep (src/jobs/dataRetention.ts).
CREATE INDEX "user_events_createdAt_idx" ON "user_events"("createdAt");
