-- rollback.sql — reverse of 20260928140000_add_signer_rotation/migration.sql
-- WARNING: DATA LOSS — dropped table/column loses any data written since the
-- migration was applied. Restore from a snapshot if the data is still needed.
-- Safe to run multiple times.
-- Run with: psql $DATABASE_URL -f prisma/migrations/20260928140000_add_signer_rotation/rollback.sql

ALTER TABLE "multisig_envelopes" DROP COLUMN IF EXISTS "signerSetVersion";
DROP TABLE IF EXISTS "signer_rotations";
DROP TYPE IF EXISTS "SignerRotationStatus";
