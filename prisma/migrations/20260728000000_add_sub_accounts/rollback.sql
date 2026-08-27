-- Rollback for 20260728000000_add_sub_accounts
-- Drops sub-account delegation (#287) and the acting-as audit columns.
--
-- WARNING — THIS IS A PERMISSIONS ROLLBACK. Read before running:
--
--   * Every delegation relationship is destroyed. Any parent currently acting
--     on a child's funds LOSES that access immediately. This fails CLOSED:
--     requireSubAccountPermission (src/middleware/subAccount.ts) demands an
--     ACTIVE SubAccount row, so with the table gone every delegated
--     deposit/withdraw is rejected rather than silently allowed. Self-access is
--     unaffected — it short-circuits before any DB lookup.
--   * Dropping "actingAsUserId" from transactions and agent_logs DESTROYS THE
--     AUDIT TRAIL of who acted on whose behalf. That history is not
--     recoverable. Export it first if the delegation feature was ever used in
--     production:
--       COPY (SELECT id, "userId", "actingAsUserId", "createdAt" FROM transactions
--             WHERE "actingAsUserId" IS NOT NULL) TO '/tmp/acting_as_transactions.csv' CSV HEADER;
--       COPY (SELECT id, "userId", "actingAsUserId", "createdAt" FROM agent_logs
--             WHERE "actingAsUserId" IS NOT NULL) TO '/tmp/acting_as_agent_logs.csv' CSV HEADER;
--
-- Deploy the reverted application code BEFORE running this: the live code reads
-- sub_accounts on every deposit/withdraw and writes actingAsUserId, so dropping
-- them underneath a running server produces errors on those paths.

ALTER TABLE "sub_accounts" DROP CONSTRAINT IF EXISTS "sub_accounts_childUserId_fkey";
ALTER TABLE "sub_accounts" DROP CONSTRAINT IF EXISTS "sub_accounts_parentUserId_fkey";

DROP INDEX IF EXISTS "agent_logs_actingAsUserId_idx";
DROP INDEX IF EXISTS "transactions_actingAsUserId_idx";
DROP INDEX IF EXISTS "sub_accounts_status_idx";
DROP INDEX IF EXISTS "sub_accounts_childUserId_idx";
DROP INDEX IF EXISTS "sub_accounts_parentUserId_idx";
DROP INDEX IF EXISTS "sub_accounts_parentUserId_childUserId_key";

DROP TABLE IF EXISTS "sub_accounts";

ALTER TABLE "agent_logs" DROP COLUMN IF EXISTS "actingAsUserId";
ALTER TABLE "transactions" DROP COLUMN IF EXISTS "actingAsUserId";

-- Enums must go last: the table and columns above depend on them.
DROP TYPE IF EXISTS "SubAccountStatus";
DROP TYPE IF EXISTS "SubAccountPermission";
