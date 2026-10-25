CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "published_strategies_label_trgm_idx" ON "published_strategies" USING gin ("label" gin_trgm_ops);
CREATE INDEX "published_strategies_description_trgm_idx" ON "published_strategies" USING gin ("description" gin_trgm_ops);
CREATE INDEX "published_strategies_tags_idx" ON "published_strategies" USING gin ("tags");
