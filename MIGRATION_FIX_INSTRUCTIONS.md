# Migration Fix Instructions

## Problem
The migration `20260928172500_add_referral_fraud_detection` failed because columns `reviewedBy` and `reviewedAt` already exist in the `referral_conversions` table (added by an earlier migration `20260830163707_add_referral_fraud_review`).

## Solution Applied
The migration files have been updated to use `IF NOT EXISTS` clauses to safely handle existing columns.

## Steps to Resolve

### 1. Mark the Failed Migration as Rolled Back
```bash
npx prisma migrate resolve --rolled-back 20260928172500_add_referral_fraud_detection
```

This tells Prisma that the migration failed and should be retried.

### 2. Apply Migrations Again
```bash
npx prisma migrate deploy
```

The updated migration will now succeed because it uses `ADD COLUMN IF NOT EXISTS`.

## What Was Changed

### Before (Caused Error):
```sql
ALTER TABLE "referral_conversions" ADD COLUMN "reviewedBy" TEXT;
ALTER TABLE "referral_conversions" ADD COLUMN "reviewedAt" TIMESTAMP(3);
```

### After (Fixed):
```sql
-- Removed reviewedBy and reviewedAt since they already exist from migration 20260830163707
ALTER TABLE "referral_conversions" ADD COLUMN IF NOT EXISTS "fraudCheckScore" INTEGER;
ALTER TABLE "referral_conversions" ADD COLUMN IF NOT EXISTS "fraudCheckFlags" TEXT[] DEFAULT ARRAY[]::TEXT[];
-- ... other new columns with IF NOT EXISTS
```

## Verification

After successful migration, verify the table structure:
```bash
psql $DATABASE_URL -c "\d referral_conversions"
```

You should see all these columns:
- `fraudCheckScore` (INTEGER)
- `fraudCheckFlags` (TEXT[])
- `fraudCheckDetails` (JSONB)
- `manualReviewRequired` (BOOLEAN)
- `manualReviewRejected` (BOOLEAN)
- `reviewedBy` (TEXT) - from earlier migration
- `reviewedAt` (TIMESTAMP) - from earlier migration
- `rejectionReason` (TEXT)

## Notes
- The columns `reviewedBy` and `reviewedAt` were already added by migration `20260830163707_add_referral_fraud_review`
- Our implementation reuses these existing columns for consistency
- No data loss will occur from this fix
