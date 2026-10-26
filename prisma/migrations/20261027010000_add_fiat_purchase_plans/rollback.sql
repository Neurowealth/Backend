-- Rollback for 20261027010000_add_fiat_purchase_plans
DROP TABLE IF EXISTS "fiat_purchase_plan_runs" CASCADE;
DROP TABLE IF EXISTS "fiat_purchase_plans" CASCADE;
