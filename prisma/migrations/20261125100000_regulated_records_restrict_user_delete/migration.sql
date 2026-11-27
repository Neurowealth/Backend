-- #934: AML/KYC records must outlive a privacy erasure.
--
-- Transaction, FiatOrder, KycProfile, CollateralLoan (and the position that
-- collateralises it) and ComplianceCase used to ON DELETE CASCADE from users,
-- so deleting a user silently destroyed regulated records. They are now
-- RESTRICT: executeErasure re-points them at a pseudonymous retention stub
-- before deleting the user, and any other path that tries to delete a user who
-- still owns one of these rows fails closed instead of cascading.

ALTER TABLE "transactions" DROP CONSTRAINT "transactions_userId_fkey";
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "fiat_orders" DROP CONSTRAINT "fiat_orders_userId_fkey";
ALTER TABLE "fiat_orders" ADD CONSTRAINT "fiat_orders_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "kyc_profiles" DROP CONSTRAINT "kyc_profiles_userId_fkey";
ALTER TABLE "kyc_profiles" ADD CONSTRAINT "kyc_profiles_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "collateral_loans" DROP CONSTRAINT "collateral_loans_userId_fkey";
ALTER TABLE "collateral_loans" ADD CONSTRAINT "collateral_loans_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "collateral_loans" DROP CONSTRAINT "collateral_loans_positionId_fkey";
ALTER TABLE "collateral_loans" ADD CONSTRAINT "collateral_loans_positionId_fkey"
  FOREIGN KEY ("positionId") REFERENCES "positions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "compliance_cases" DROP CONSTRAINT "compliance_cases_userId_fkey";
ALTER TABLE "compliance_cases" ADD CONSTRAINT "compliance_cases_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
