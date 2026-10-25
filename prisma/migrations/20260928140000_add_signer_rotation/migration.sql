CREATE TYPE "SignerRotationStatus" AS ENUM ('PENDING', 'DUAL_ACTIVE', 'FINALIZED', 'CANCELLED');

CREATE TABLE "signer_rotations" (
  "id" TEXT NOT NULL,
  "treasuryAccountId" TEXT NOT NULL,
  "oldSignerKey" TEXT NOT NULL,
  "newSignerKey" TEXT NOT NULL,
  "status" "SignerRotationStatus" NOT NULL DEFAULT 'PENDING',
  "dualActiveSince" TIMESTAMP(3),
  "finalizedAt" TIMESTAMP(3),
  "initiatedBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "signer_rotations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "signer_rotations_account_status_idx" ON "signer_rotations"("treasuryAccountId", "status");

ALTER TABLE "multisig_envelopes" ADD COLUMN "signerSetVersion" INTEGER NOT NULL DEFAULT 1;
