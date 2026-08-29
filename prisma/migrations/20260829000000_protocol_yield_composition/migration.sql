-- #349: yield base/incentive composition on protocol rates.

-- baseApy / incentiveApy: the market (base) vs token-reward (incentive) split of
-- the quoted supply APY, in the same Decimal(10,6) units as supplyApy.
ALTER TABLE "protocol_rates" ADD COLUMN "baseApy" DECIMAL(10, 6);
ALTER TABLE "protocol_rates" ADD COLUMN "incentiveApy" DECIMAL(10, 6);

-- rewardTokens: JSON metadata (symbol, address, apy) for the tokens paid as
-- incentives, as returned by the protocol adapter.
ALTER TABLE "protocol_rates" ADD COLUMN "rewardTokens" JSONB;
