-- rollback.sql — reverse of 20260928160000_add_fiat_webhook_replay_receipts/migration.sql
-- Drops hash-only inbound fiat webhook replay receipts.
DROP TABLE IF EXISTS "fiat_webhook_receipts";