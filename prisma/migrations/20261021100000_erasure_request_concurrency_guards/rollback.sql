DROP INDEX IF EXISTS "erasure_requests_user_active_key";

-- Restore the original required cascading user relation.
ALTER TABLE "erasure_requests"
  DROP CONSTRAINT "erasure_requests_userId_fkey";
-- Rollback requires every request to have a user. Resolve orphaned requests
-- before applying this rollback if erasures have already completed.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "erasure_requests" WHERE "userId" IS NULL) THEN
    RAISE EXCEPTION 'Cannot restore required erasure_requests.userId: orphaned audit requests exist';
  END IF;
END $$;
ALTER TABLE "erasure_requests"
  ALTER COLUMN "userId" SET NOT NULL;
ALTER TABLE "erasure_requests"
  ADD CONSTRAINT "erasure_requests_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- PostgreSQL cannot remove an enum value in place. The PROCESSING label is
-- intentionally retained so this rollback remains safe for databases that may
-- contain rows using it. To fully revert the enum, first migrate every
-- PROCESSING row to a valid previous status, then recreate the enum type and
-- cast the column during a controlled maintenance migration.
