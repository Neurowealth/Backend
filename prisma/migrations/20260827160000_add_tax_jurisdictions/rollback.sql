-- Rollback for 20260827160000_add_tax_jurisdictions
-- Drops the per-jurisdiction tax profile selector (#356).
--
-- WARNING: Dropping "taxJurisdiction" loses each user's configured
-- jurisdiction (they revert to US on re-add). Deploy the reverted
-- application code BEFORE running this — the live report builder
-- (src/tax/report.ts's buildTaxReport) reads User.taxJurisdiction on every
-- call.

ALTER TABLE "users" DROP COLUMN IF EXISTS "taxJurisdiction";

DROP TYPE IF EXISTS "TaxJurisdiction";
