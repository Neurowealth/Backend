-- CreateEnum
CREATE TYPE "TaxJurisdiction" AS ENUM ('US', 'UK', 'DE', 'AU', 'CA');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "taxJurisdiction" "TaxJurisdiction" NOT NULL DEFAULT 'US';
