-- Hash-only idempotency records for authenticated fiat provider callbacks.
CREATE TABLE "fiat_webhook_receipts" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fiat_webhook_receipts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "fiat_webhook_receipts_provider_nonce_key"
ON "fiat_webhook_receipts"("provider", "nonce");