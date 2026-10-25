-- AlterEnum
ALTER TYPE "ErasureRequestStatus" ADD VALUE IF NOT EXISTS 'PROCESSING';

-- Preserve the compliance request record when its user is erased.
ALTER TABLE "erasure_requests"
  DROP CONSTRAINT "erasure_requests_userId_fkey";
ALTER TABLE "erasure_requests"
  ALTER COLUMN "userId" DROP NOT NULL;
ALTER TABLE "erasure_requests"
  ADD CONSTRAINT "erasure_requests_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Create partial unique index to guard against concurrent active requests per user (#684)
CREATE UNIQUE INDEX "erasure_requests_user_active_key"
ON "erasure_requests"("userId")
WHERE "status" IN ('PENDING', 'APPROVED', 'PROCESSING');
