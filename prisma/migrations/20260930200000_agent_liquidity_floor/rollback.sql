ALTER TABLE "protocol_liquidity_snapshots"
DROP COLUMN "withdrawalDelayHours";

ALTER TABLE "positions"
DROP COLUMN "liquidityLocked";

ALTER TABLE "users"
DROP COLUMN "liquidityFloor";