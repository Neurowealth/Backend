-- The indexed webhook tables are created by the later 20261003_add_missing_models
-- migration. Keep this historical migration safe on fresh deploys; the indexes
-- are created together with their tables in that migration.
DO $$
BEGIN
  IF to_regclass('public.user_webhook_deliveries') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS "user_webhook_deliveries_endpointId_createdAt_idx"
      ON "user_webhook_deliveries"("endpointId", "createdAt");
  END IF;

  IF to_regclass('public.webhook_deliveries') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS "webhook_deliveries_subscriptionId_status_createdAt_idx"
      ON "webhook_deliveries"("subscriptionId", "status", "createdAt");
  END IF;

  IF to_regclass('public.webhook_dead_letters') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS "webhook_dead_letters_subscriptionId_status_firstFailedAt_idx"
      ON "webhook_dead_letters"("subscriptionId", "status", "firstFailedAt");
  END IF;
END $$;
