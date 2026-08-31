-- rollback.sql — reverse of 20260830140000_add_reserve_sponsorship/migration.sql
-- Sponsored reserves & trustline ledger (#339).
-- WARNING: DATA LOSS — all reserve_sponsorships history is lost.
-- Revert app code BEFORE running. Drain: SELECT * FROM outbox_ops WHERE kind='ACCOUNT_PROVISION' AND status IN ('PENDING','SUBMITTED'); ensure 0.
-- IRREVERSIBLE STEP: PostgreSQL cannot drop a single enum value.
-- 'ACCOUNT_PROVISION' added to "OutboxOpKind" is left in place (harmless once
-- reserve_sponsorships is gone). To purge it, rebuild the type manually:
--   CREATE TYPE "OutboxOpKind_new" AS ENUM ('DEPOSIT','WITHDRAW','REBALANCE','RECURRING_DEPOSIT','REFERRAL_REWARD','YIELD_CLAIM','TREASURY_SWEEP');
--   ALTER TABLE "outbox_ops" ALTER COLUMN "kind" TYPE "OutboxOpKind_new" USING ("kind"::text::"OutboxOpKind_new");
--   DROP TYPE "OutboxOpKind";
--   ALTER TYPE "OutboxOpKind_new" RENAME TO "OutboxOpKind";
-- Run with: psql $DATABASE_URL -f prisma/migrations/20260830140000_add_reserve_sponsorship/rollback.sql

DROP INDEX IF EXISTS "reserve_sponsorships_sponsorAccount_status_idx";
DROP INDEX IF EXISTS "reserve_sponsorships_sponsoredId_idx";
DROP TABLE IF EXISTS "reserve_sponsorships" CASCADE;
-- OutboxOpKind 'ACCOUNT_PROVISION' intentionally retained — see note above
