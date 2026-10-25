-- Preserve erasure requests after the subject user is deleted (#680).
ALTER TABLE "erasure_requests" DROP CONSTRAINT "erasure_requests_userId_fkey";
ALTER TABLE "erasure_requests" ALTER COLUMN "userId" DROP NOT NULL;
ALTER TABLE "erasure_requests" ADD CONSTRAINT "erasure_requests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
