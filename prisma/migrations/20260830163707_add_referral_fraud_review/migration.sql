-- #397 — referral fraud/abuse detection: a FLAGGED status plus the review
-- trail on referral_conversions, so a suspicious conversion is held for
-- manual review instead of silently activating or being blocked outright.

ALTER TYPE "ReferralStatus" ADD VALUE 'FLAGGED';

ALTER TABLE "referral_conversions"
  ADD COLUMN "fraudReasons" TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN "flaggedAt" TIMESTAMP(3),
  ADD COLUMN "reviewedAt" TIMESTAMP(3),
  ADD COLUMN "reviewedBy" TEXT,
  ADD COLUMN "reviewDecision" TEXT;
