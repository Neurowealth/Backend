-- Add fraud detection fields to referral_conversions (#490)
-- Note: reviewedBy and reviewedAt already exist from migration 20260830163707_add_referral_fraud_review
ALTER TABLE "referral_conversions" ADD COLUMN IF NOT EXISTS "fraudCheckScore" INTEGER;
ALTER TABLE "referral_conversions" ADD COLUMN IF NOT EXISTS "fraudCheckFlags" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "referral_conversions" ADD COLUMN IF NOT EXISTS "fraudCheckDetails" JSONB;
ALTER TABLE "referral_conversions" ADD COLUMN IF NOT EXISTS "manualReviewRequired" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "referral_conversions" ADD COLUMN IF NOT EXISTS "manualReviewRejected" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "referral_conversions" ADD COLUMN IF NOT EXISTS "rejectionReason" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "referral_conversions_manualReviewRequired_idx" ON "referral_conversions"("manualReviewRequired");
