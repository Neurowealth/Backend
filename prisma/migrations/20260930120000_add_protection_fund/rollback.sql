-- Rollback for #533 Protocol-Risk Protection Fund

DROP TABLE IF EXISTS "coverage_claims";
DROP TABLE IF EXISTS "coverage_events";
DROP TABLE IF EXISTS "protection_fund_contributions";
DROP TABLE IF EXISTS "protection_fund_balances";
