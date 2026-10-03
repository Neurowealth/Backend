# Concurrent Index Migration Fix

## Problem
Migration `20260928180000_add_webhook_query_indexes` failed because it uses `CREATE INDEX CONCURRENTLY`, which cannot run inside Prisma's transaction-wrapped migration.

Error:
```
ERROR: CREATE INDEX CONCURRENTLY cannot run inside a transaction block
```

## Root Cause
Prisma's `migrate deploy` wraps all migrations in a transaction for safety, but PostgreSQL's `CREATE INDEX CONCURRENTLY` explicitly requires running **outside** a transaction to allow concurrent reads/writes during index creation.

## Solution Options

### Option 1: Apply Index Migration Manually (Recommended for Production)

1. **Mark the failed migration as rolled back:**
```bash
npx prisma migrate resolve --rolled-back 20260928180000_add_webhook_query_indexes
```

2. **Apply the concurrent indexes manually** (outside of Prisma migrations):
```bash
psql $DATABASE_URL << 'EOF'
-- Apply each index separately (they're already CONCURRENTLY, so they won't lock the tables)
CREATE INDEX CONCURRENTLY IF NOT EXISTS "user_webhook_deliveries_endpointId_createdAt_idx"
ON "user_webhook_deliveries"("endpointId", "createdAt");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "webhook_deliveries_subscriptionId_status_createdAt_idx"
ON "webhook_deliveries"("subscriptionId", "status", "createdAt");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "webhook_dead_letters_subscriptionId_status_firstFailedAt_idx"
ON "webhook_dead_letters"("subscriptionId", "status", "firstFailedAt");
EOF
```

3. **Mark the migration as applied** (so Prisma knows it's done):
```bash
npx prisma migrate resolve --applied 20260928180000_add_webhook_query_indexes
```

4. **Continue with remaining migrations:**
```bash
npx prisma migrate deploy
```

### Option 2: Remove CONCURRENTLY for CI/Test Environments (Simpler but blocks table)

If this is a test/staging environment where downtime is acceptable:

1. **Edit the migration file** to remove `CONCURRENTLY`:
```bash
# Edit: prisma/migrations/20260928180000_add_webhook_query_indexes/migration.sql
# Change:
CREATE INDEX CONCURRENTLY "index_name" ...
# To:
CREATE INDEX "index_name" ...
```

2. **Mark as rolled back and retry:**
```bash
npx prisma migrate resolve --rolled-back 20260928180000_add_webhook_query_indexes
npx prisma migrate deploy
```

**Caveat:** Without `CONCURRENTLY`, the table will be locked during index creation (not ideal for production).

### Option 3: Split Migration into Non-Concurrent (Best for CI/CD)

Create a new migration that replaces the concurrent one:

1. **Mark failed migration as rolled back:**
```bash
npx prisma migrate resolve --rolled-back 20260928180000_add_webhook_query_indexes
```

2. **Delete or rename the problematic migration folder** (so it doesn't run again)

3. **Create regular indexes via Prisma schema:**
Add `@@index` directives to the models in `prisma/schema.prisma`, then run:
```bash
npx prisma migrate dev --name add_webhook_query_indexes_regular
```

This will create a new migration without `CONCURRENTLY`.

## Recommended Approach by Environment

### For CI/CD Test Databases (like prod_smoke_db)
**Use Option 2** - Remove `CONCURRENTLY` since test databases don't need zero-downtime index creation.

### For Production Databases
**Use Option 1** - Apply indexes manually with `CONCURRENTLY` to avoid locking tables during index creation.

## Verification

After applying the fix, verify indexes were created:
```sql
SELECT
  schemaname,
  tablename,
  indexname,
  indexdef
FROM pg_indexes
WHERE tablename IN ('user_webhook_deliveries', 'webhook_deliveries', 'webhook_dead_letters')
AND indexname LIKE '%_idx';
```

## Why This Happened

The migration was written to optimize production deployments (using `CONCURRENTLY` to avoid table locks), but Prisma's migration system doesn't support this pattern out-of-the-box. This is a known limitation.

**Future Prevention:** For concurrent index migrations, either:
1. Apply them manually outside of Prisma migrations
2. Use regular (blocking) indexes in test environments
3. Document that certain migrations need manual application
