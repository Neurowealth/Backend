-- Rollback for 20261020090000_ticket_sla_treasury_enable
-- Drops the support ticket first-response timestamp and the treasury sweep
-- policy enablement columns.
-- WARNING: Destroys firstResponseAt history and which policies were enabled;
-- after rollback no sweep-enable state remains, so re-add it before sweeping.

ALTER TABLE "treasury_sweep_policies" DROP COLUMN IF EXISTS "enabledAt";
ALTER TABLE "treasury_sweep_policies" DROP COLUMN IF EXISTS "enabledBy";
ALTER TABLE "treasury_sweep_policies" DROP COLUMN IF EXISTS "sweepsEnabled";

ALTER TABLE "support_tickets" DROP COLUMN IF EXISTS "firstResponseAt";
