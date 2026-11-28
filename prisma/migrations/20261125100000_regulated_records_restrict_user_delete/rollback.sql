-- Rollback for 20261125100000_regulated_records_restrict_user_delete (#934).
-- Restores the original ON DELETE CASCADE behaviour.

ALTER TABLE "transactions" DROP CONSTRAINT "transactions_userId_fkey";
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "fiat_orders" DROP CONSTRAINT "fiat_orders_userId_fkey";
ALTER TABLE "fiat_orders" ADD CONSTRAINT "fiat_orders_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "kyc_profiles" DROP CONSTRAINT "kyc_profiles_userId_fkey";
ALTER TABLE "kyc_profiles" ADD CONSTRAINT "kyc_profiles_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "collateral_loans" DROP CONSTRAINT "collateral_loans_userId_fkey";
ALTER TABLE "collateral_loans" ADD CONSTRAINT "collateral_loans_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "collateral_loans" DROP CONSTRAINT "collateral_loans_positionId_fkey";
ALTER TABLE "collateral_loans" ADD CONSTRAINT "collateral_loans_positionId_fkey"
  FOREIGN KEY ("positionId") REFERENCES "positions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "compliance_cases" DROP CONSTRAINT "compliance_cases_userId_fkey";
ALTER TABLE "compliance_cases" ADD CONSTRAINT "compliance_cases_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
