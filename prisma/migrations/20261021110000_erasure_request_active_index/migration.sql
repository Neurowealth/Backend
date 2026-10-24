-- Run after the PROCESSING enum value was committed by the preceding migration.
-- Guard against concurrent active requests per user (#684).
CREATE UNIQUE INDEX "erasure_requests_user_active_key"
ON "erasure_requests"("userId")
WHERE "status" IN ('PENDING', 'APPROVED', 'PROCESSING');
