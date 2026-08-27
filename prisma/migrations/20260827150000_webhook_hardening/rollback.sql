ALTER TABLE "webhook_dead_letters" DROP CONSTRAINT IF EXISTS "webhook_dead_letters_subscriptionId_fkey";
DROP TABLE IF EXISTS "webhook_dead_letters";
ALTER TABLE "webhook_subscriptions" DROP COLUMN IF EXISTS "autoReplay";
ALTER TABLE "webhook_subscriptions" DROP COLUMN IF EXISTS "secretNextActiveAt";
ALTER TABLE "webhook_subscriptions" DROP COLUMN IF EXISTS "secretNext";
