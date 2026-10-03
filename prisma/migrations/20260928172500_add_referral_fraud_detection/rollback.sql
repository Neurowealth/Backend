-- DropIndex
DROP INDEX IF EXISTS "referral_conversions_manualReviewRequired_idx";

-- Remove fraud detection fields from referral_conversions
-- Note: reviewedBy and reviewedAt are NOT dropped as they were added by migration 20260830163707_add_referral_fraud_review
ALTER TABLE "referral_conversions" DROP COLUMN IF EXISTS "fraudCheckScore";
ALTER TABLE "referral_conversions" DROP COLUMN IF EXISTS "fraudCheckFlags";
ALTER TABLE "referral_conversions" DROP COLUMN IF EXISTS "fraudCheckDetails";
ALTER TABLE "referral_conversions" DROP COLUMN IF EXISTS "manualReviewRequired";
ALTER TABLE "referral_conversions" DROP COLUMN IF EXISTS "manualReviewRejected";
ALTER TABLE "referral_conversions" DROP COLUMN IF EXISTS "rejectionReason";
