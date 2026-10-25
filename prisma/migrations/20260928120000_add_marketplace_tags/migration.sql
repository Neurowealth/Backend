CREATE TABLE "marketplace_tags" (
  "id" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "marketplace_tags_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "marketplace_tags_slug_key" ON "marketplace_tags"("slug");
CREATE INDEX "marketplace_tags_isActive_idx" ON "marketplace_tags"("isActive");

ALTER TABLE "published_strategies" ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "published_strategies" ADD COLUMN "description" TEXT;

INSERT INTO "marketplace_tags" ("id", "slug", "label") VALUES
  (gen_random_uuid()::text, 'conservative', 'Conservative'),
  (gen_random_uuid()::text, 'max-yield', 'Max Yield'),
  (gen_random_uuid()::text, 'goal-oriented', 'Goal Oriented'),
  (gen_random_uuid()::text, 'diversified', 'Diversified');
