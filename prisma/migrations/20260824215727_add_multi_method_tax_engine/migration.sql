-- CreateEnum
CREATE TYPE "AccountingMethod" AS ENUM ('FIFO', 'LIFO', 'HIFO', 'SPECIFIC_ID');

-- AlterEnum
ALTER TYPE "PriceSource" ADD VALUE 'USER_DECLARED';
ALTER TYPE "PriceSource" ADD VALUE 'MARKET_FEED';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "accountingMethod" "AccountingMethod" NOT NULL DEFAULT 'FIFO',
ADD COLUMN     "methodEffectiveAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "selectedLotIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
