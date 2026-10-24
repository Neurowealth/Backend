-- Refuse to discard transfer history during rollback.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "transactions" WHERE "type" = 'INTERNAL_TRANSFER'
  ) OR EXISTS (SELECT 1 FROM "internal_transfers") THEN
    RAISE EXCEPTION 'Cannot roll back peer-to-peer transfers while transfer history exists';
  END IF;
END $$;

ALTER TABLE "transactions"
  DROP CONSTRAINT IF EXISTS "transactions_internalTransferId_fkey";
DROP INDEX IF EXISTS "transactions_internalTransferId_idx";
DROP INDEX IF EXISTS "internal_transfers_senderUserId_createdAt_idx";
DROP INDEX IF EXISTS "internal_transfers_recipientUserId_createdAt_idx";
DROP INDEX IF EXISTS "internal_transfers_senderUserId_recipientHandle_idx";
ALTER TABLE "transactions" DROP COLUMN IF EXISTS "internalTransferId";
DROP TABLE IF EXISTS "internal_transfers";

ALTER TABLE "transactions" ALTER COLUMN "type" TYPE TEXT;
CREATE TYPE "TransactionType_old" AS ENUM (
  'DEPOSIT',
  'WITHDRAWAL',
  'YIELD_CLAIM',
  'REBALANCE',
  'SWAP',
  'REFERRAL_REWARD',
  'INBOUND_TRANSFER',
  'CLAIMABLE_BALANCE_CLAIM',
  'LOAN_DISBURSE',
  'LOAN_REPAYMENT',
  'LOAN_LIQUIDATION'
);
ALTER TABLE "transactions"
  ALTER COLUMN "type" TYPE "TransactionType_old"
  USING ("type"::"TransactionType_old");
DROP TYPE "TransactionType";
ALTER TYPE "TransactionType_old" RENAME TO "TransactionType";
