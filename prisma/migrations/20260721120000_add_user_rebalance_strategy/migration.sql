-- Repair schema drift: User.rebalanceStrategy / User.strategyConfig exist in
-- schema.prisma but were never added by a migration, so fresh databases built
-- via `prisma migrate deploy` were missing them. Nullable columns — no backfill.

-- AlterTable
ALTER TABLE "users" ADD COLUMN "rebalanceStrategy" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN "strategyConfig" JSONB;
