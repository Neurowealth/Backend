-- DropForeignKey
ALTER TABLE "erasure_requests" DROP CONSTRAINT "erasure_requests_userId_fkey";

-- DropTable
DROP TABLE "erasure_requests";

-- DropEnum
DROP TYPE "ErasureRequestStatus";
