-- #534 Multi-Currency Portfolio Display
ALTER TABLE "users" ADD COLUMN "displayCurrency" TEXT NOT NULL DEFAULT 'USD';
