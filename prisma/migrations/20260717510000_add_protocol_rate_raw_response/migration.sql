-- Capture the raw provider payload alongside each scanned protocol rate for
-- debugging/audit. Nullable so historical rows need no backfill.

-- AlterTable
ALTER TABLE "protocol_rates" ADD COLUMN "rawResponse" TEXT;
