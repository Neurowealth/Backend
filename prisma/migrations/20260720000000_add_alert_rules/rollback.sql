-- Rollback for 20260720000000_add_alert_rules
-- Drops the user-defined alert rule table, its enums, and the users.phone
-- column added for WhatsApp delivery.
-- WARNING: Destroys all user-configured alert rules and their cooldown state
-- (lastFiredAt), plus any linked WhatsApp phone numbers. None of this is
-- reconstructible from other tables — rules are user input, not derived data.
-- Re-applying the migration restores the schema but not the rows.

ALTER TABLE "alert_rules" DROP CONSTRAINT IF EXISTS "alert_rules_userId_fkey";

DROP INDEX IF EXISTS "users_phone_key";

ALTER TABLE "users" DROP COLUMN IF EXISTS "phone";

DROP TABLE IF EXISTS "alert_rules";

DROP TYPE IF EXISTS "DeliveryChannel";

DROP TYPE IF EXISTS "Comparator";

DROP TYPE IF EXISTS "AlertMetric";
