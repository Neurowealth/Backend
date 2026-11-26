-- Rollback: 20261021000000_erasure_request_preserve_on_user_delete
-- DATA LOSS: requests whose user was deleted cannot regain that user. Remove
-- those orphaned request rows before restoring the original NOT NULL FK.
DELETE FROM "erasure_requests" WHERE "userId" IS NULL;
ALTER TABLE "erasure_requests"
  DROP CONSTRAINT IF EXISTS "erasure_requests_userId_fkey";
ALTER TABLE "erasure_requests" ALTER COLUMN "userId" SET NOT NULL;
ALTER TABLE "erasure_requests"
  ADD CONSTRAINT "erasure_requests_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
