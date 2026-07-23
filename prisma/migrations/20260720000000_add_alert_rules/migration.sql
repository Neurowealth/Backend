-- Custom price & yield alert rules (#289). User-defined conditions evaluated
-- on a schedule by src/jobs/alertRules.ts; distinct from operator-facing
-- Prometheus/Grafana alerting.

-- CreateEnum
CREATE TYPE "AlertMetric" AS ENUM ('PROTOCOL_APY', 'PORTFOLIO_VALUE', 'POSITION_DRAWDOWN');

-- CreateEnum
CREATE TYPE "Comparator" AS ENUM ('LT', 'LTE', 'GT', 'GTE');

-- CreateEnum
CREATE TYPE "DeliveryChannel" AS ENUM ('WEBHOOK', 'WHATSAPP', 'BOTH');

-- CreateTable
CREATE TABLE "alert_rules" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "metric" "AlertMetric" NOT NULL,
    "protocolName" TEXT,
    "comparator" "Comparator" NOT NULL,
    "threshold" DECIMAL(36,18) NOT NULL,
    "deliveryChannel" "DeliveryChannel" NOT NULL,
    "cooldownMinutes" INTEGER NOT NULL DEFAULT 60,
    "lastFiredAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alert_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "alert_rules_userId_idx" ON "alert_rules"("userId");

-- CreateIndex
CREATE INDEX "alert_rules_isActive_metric_idx" ON "alert_rules"("isActive", "metric");

-- AddForeignKey
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Optional WhatsApp delivery destination for alert rules. Nullable + unique.
-- AlterTable
ALTER TABLE "users" ADD COLUMN "phone" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");
