-- Rollback for 20260717510000_add_protocol_rate_raw_response
-- Drops the rawResponse debug/audit column from protocol_rates.
-- WARNING: Destroys captured raw provider payloads for existing rows.

ALTER TABLE "protocol_rates" DROP COLUMN IF EXISTS "rawResponse";
