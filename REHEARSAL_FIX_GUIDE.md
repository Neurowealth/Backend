# Migration Rehearsal Fix Guide

## Problem
The migration rehearsal script failed because migration `20260928200000_add_totp_credentials` had SQL syntax errors that were fixed AFTER the migration was already attempted in the rehearsal database.

## Why This Happens
1. Rehearsal script runs `npx prisma migrate deploy` which attempts all pending migrations
2. Migration `20260928200000_add_totp_credentials` had syntax errors and failed
3. Prisma recorded the failed state in `_prisma_migrations` table
4. We fixed the SQL in the migration file
5. Running rehearsal again still sees the old failed attempt in the database

## Solution

### Step 1: Mark the Failed Migration as Rolled Back

This tells Prisma that the migration should be retried.

```bash
# Using the helper script:
DATABASE_URL="postgresql://rehearsal_user:rehearsal_password@localhost:5434/rehearsal_db" \
  bash scripts/fix-failed-rehearsal.sh 20260928200000_add_totp_credentials

# Or manually:
DATABASE_URL="postgresql://rehearsal_user:rehearsal_password@localhost:5434/rehearsal_db" \
  npx prisma migrate resolve --rolled-back 20260928200000_add_totp_credentials
```

### Step 2: Run the Rehearsal Again

```bash
DATABASE_URL="postgresql://rehearsal_user:rehearsal_password@localhost:5434/rehearsal_db" \
  bash scripts/rehearse-migration-rollback.sh
```

The migration will now use the fixed SQL.

## Alternative: Reset the Rehearsal Database

If marking as rolled back doesn't work, you can completely reset the rehearsal database:

```bash
# Drop and recreate the rehearsal database
psql -h localhost -p 5434 -U postgres << 'EOF'
DROP DATABASE IF EXISTS rehearsal_db;
CREATE DATABASE rehearsal_db;
GRANT ALL PRIVILEGES ON DATABASE rehearsal_db TO rehearsal_user;
EOF

# Run rehearsal with fresh database
DATABASE_URL="postgresql://rehearsal_user:rehearsal_password@localhost:5434/rehearsal_db" \
  bash scripts/rehearse-migration-rollback.sh
```

## What Was Fixed in the Migration

### Original Issues (Now Fixed):
1. **SQL Typos**: `"IDIFNOT EXISTS"` → `IF NOT EXISTS`
2. **PostgreSQL Compatibility**: Replaced `ADD CONSTRAINT IF NOT EXISTS` with a DO block for compatibility with PostgreSQL < 12

### Current State:
The migration file now contains correct, PostgreSQL-compatible SQL that will work in rehearsal.

## For CI/CD Environments

If this happens in CI, the pipeline should:
1. Mark the failed migration as rolled back
2. Re-run the deployment

Add this to your CI script:
```bash
#!/bin/bash
set -e

# Try to deploy migrations
if ! npx prisma migrate deploy; then
  echo "Migration failed, checking for recoverable failures..."
  
  # Get the last failed migration
  FAILED_MIGRATION=$(psql "$DATABASE_URL" -tAc \
    "SELECT migration_name FROM _prisma_migrations 
     WHERE finished_at IS NULL AND rolled_back_at IS NULL 
     ORDER BY started_at DESC LIMIT 1;" | tr -d '[:space:]')
  
  if [ -n "$FAILED_MIGRATION" ]; then
    echo "Marking $FAILED_MIGRATION as rolled back and retrying..."
    npx prisma migrate resolve --rolled-back "$FAILED_MIGRATION"
    npx prisma migrate deploy
  else
    exit 1
  fi
fi
```

## Prevention

To avoid this issue in the future:
1. **Always test migrations locally** before committing
2. **Run rehearsal script** before pushing migration changes
3. **Use proper SQL syntax** - avoid shortcuts
4. **Check PostgreSQL compatibility** for the versions you support
5. **Use idempotent SQL** - always use `IF NOT EXISTS` / `IF EXISTS` where possible

## Reference

- **Helper Script**: `scripts/fix-failed-rehearsal.sh`
- **Rehearsal Script**: `scripts/rehearse-migration-rollback.sh`
- **Fixed Migration**: `prisma/migrations/20260928200000_add_totp_credentials/`
