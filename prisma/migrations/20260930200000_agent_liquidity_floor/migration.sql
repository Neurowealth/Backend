ALTER TABLE "users"
ADD COLUMN "liquidityFloor" DECIMAL(36, 18);

ALTER TABLE "positions"
ADD COLUMN "liquidityLocked" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "protocol_liquidity_snapshots"
ADD COLUMN "withdrawalDelayHours" INTEGER;