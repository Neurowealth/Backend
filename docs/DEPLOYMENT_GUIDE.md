# Deployment Guide - Vault Events Persistence

> For production secrets, migration roll-forward/rollback, and the full release checklist, see **[PRODUCTION_DEPLOYMENT.md](./PRODUCTION_DEPLOYMENT.md)**.

## Pre-Deployment Checklist

- [x] Code review completed
- [x] Tests passing
- [x] Documentation complete
- [x] Migration created
- [x] No breaking changes

## Deployment Steps

### 1. Apply Database Migration

```bash
# Generate Prisma client
npm run prisma:generate

# Apply migration
npx prisma migrate deploy

# Verify migration
npx prisma db execute --stdin < prisma/migrations/20260326152030_add_event_tracking/migration.sql
```

### 2. Verify Database Changes

```bash
# Check EventCursor table
psql $DATABASE_URL -c "SELECT * FROM event_cursors;"

# Check ProcessedEvent table
psql $DATABASE_URL -c "SELECT * FROM processed_events;"

# Verify indexes
psql $DATABASE_URL -c "\d event_cursors"
psql $DATABASE_URL -c "\d processed_events"
```

### 3. Build and Test

```bash
# Install dependencies
npm install

# Run linting
npm run lint

# Run tests
npm test -- --run

# Build
npm run build
```

### 4. Start Event Listener

```bash
# In your application startup code
import { startEventListener } from './src/stellar/events';

// Start listening for events
await startEventListener();
```

### 5. Monitor Event Processing

```bash
# Check last processed ledger
psql $DATABASE_URL -c "SELECT * FROM event_cursors WHERE contractId = '$VAULT_CONTRACT_ID';"

# Check processed events count
psql $DATABASE_URL -c "SELECT COUNT(*) FROM processed_events;"

# Check recent transactions
psql $DATABASE_URL -c "SELECT * FROM transactions ORDER BY createdAt DESC LIMIT 10;"

# Check recent positions
psql $DATABASE_URL -c "SELECT * FROM positions ORDER BY updatedAt DESC LIMIT 10;"
```

## Rollback Procedure

### If Issues Occur

```bash
# Stop event listener
import { stopEventListener } from './src/stellar/events';
stopEventListener();

# Rollback migration
npx prisma migrate resolve --rolled-back 20260326152030_add_event_tracking

# Verify rollback
psql $DATABASE_URL -c "\dt" # Should not show event_cursors or processed_events
```

## Post-Deployment Verification

### 1. Check Event Processing

```bash
# Wait 30 seconds for events to be processed
sleep 30

# Verify cursor was updated
psql $DATABASE_URL -c "SELECT * FROM event_cursors;"

# Verify events were processed
psql $DATABASE_URL -c "SELECT COUNT(*) FROM processed_events;"

# Verify transactions were created
psql $DATABASE_URL -c "SELECT COUNT(*) FROM transactions WHERE status = 'CONFIRMED';"
```

### 2. Monitor Logs

```bash
# Check for errors
grep -i "error" logs/*.log

# Check for event processing
grep -i "event" logs/*.log

# Check for warnings
grep -i "warn" logs/*.log
```

### 3. Verify Data Integrity

```bash
# Check for duplicate transactions
psql $DATABASE_URL -c "SELECT txHash, COUNT(*) FROM transactions GROUP BY txHash HAVING COUNT(*) > 1;"

# Check for orphaned transactions
psql $DATABASE_URL -c "SELECT * FROM transactions WHERE positionId IS NULL AND type IN ('DEPOSIT', 'WITHDRAWAL');"

# Check position balances
psql $DATABASE_URL -c "SELECT userId, protocolName, depositedAmount, currentValue FROM positions WHERE status = 'ACTIVE';"
```

## Performance Monitoring

### Key Metrics to Track

```bash
# Event processing rate
psql $DATABASE_URL -c "SELECT COUNT(*) FROM processed_events WHERE processedAt > NOW() - INTERVAL '1 hour';"

# Average processing time
psql $DATABASE_URL -c "SELECT AVG(EXTRACT(EPOCH FROM (processedAt - createdAt))) FROM processed_events WHERE processedAt > NOW() - INTERVAL '1 hour';"

# Ledger lag
psql $DATABASE_URL -c "SELECT lastProcessedLedger FROM event_cursors WHERE contractId = '$VAULT_CONTRACT_ID';"

# Database size
psql $DATABASE_URL -c "SELECT pg_size_pretty(pg_total_relation_size('processed_events'));"
```

## Troubleshooting

### Events Not Processing

1. **Check listener is running**
   ```bash
   # In application logs
   grep "Event Listener" logs/*.log
   ```

2. **Check VAULT_CONTRACT_ID**
   ```bash
   echo $VAULT_CONTRACT_ID
   ```

3. **Check database connection**
   ```bash
   psql $DATABASE_URL -c "SELECT 1;"
   ```

4. **Check RPC connection**
   ```bash
   # In application logs
   grep "RPC" logs/*.log
   ```

### Duplicate Events

1. **Check ProcessedEvent table**
   ```bash
   psql $DATABASE_URL -c "SELECT * FROM processed_events WHERE txHash = 'YOUR_TX_HASH';"
   ```

2. **Verify unique constraint**
   ```bash
   psql $DATABASE_URL -c "\d processed_events"
   ```

3. **Check for concurrent listeners**
   ```bash
   # Should only have one listener running
   ps aux | grep "node"
   ```

### Listener Not Resuming

1. **Check EventCursor table**
   ```bash
   psql $DATABASE_URL -c "SELECT * FROM event_cursors;"
   ```

2. **Check migration was applied**
   ```bash
   npx prisma migrate status
   ```

3. **Check database logs**
   ```bash
   # PostgreSQL logs
   tail -f /var/log/postgresql/postgresql.log
   ```

## Scaling Considerations

### For High Event Volume

1. **Increase poll frequency** (if needed)
   - Modify POLL_INTERVAL_MS in events.ts
   - Default: 5000ms (5 seconds)

2. **Batch processing**
   - Process multiple events in single transaction
   - Reduces database round trips

3. **Connection pooling**
   - Use PgBouncer or similar
   - Reduce connection overhead

4. **Database optimization**
   - Add more indexes if needed
   - Archive old processed events
   - Partition large tables

## Maintenance Tasks

### Daily

```bash
# Check event processing status
psql $DATABASE_URL -c "SELECT * FROM event_cursors;"

# Check for errors in logs
grep -i "error" logs/*.log | tail -20
```

### Weekly

```bash
# Check database size
psql $DATABASE_URL -c "SELECT pg_size_pretty(pg_total_relation_size('processed_events'));"

# Archive old processed events (optional)
psql $DATABASE_URL -c "DELETE FROM processed_events WHERE processedAt < NOW() - INTERVAL '30 days';"

# Analyze query performance
psql $DATABASE_URL -c "ANALYZE processed_events;"
```

### Monthly

```bash
# Vacuum database
psql $DATABASE_URL -c "VACUUM ANALYZE;"

# Check index usage
psql $DATABASE_URL -c "SELECT * FROM pg_stat_user_indexes WHERE schemaname = 'public';"

# Review slow queries
# Check PostgreSQL slow query log
```

## Disaster Recovery

### If Database Corrupted

1. **Stop event listener**
   ```bash
   stopEventListener();
   ```

2. **Restore from backup**
   ```bash
   # Restore database from backup
   pg_restore -d $DATABASE_URL backup.dump
   ```

3. **Verify data integrity**
   ```bash
   psql $DATABASE_URL -c "SELECT COUNT(*) FROM event_cursors;"
   psql $DATABASE_URL -c "SELECT COUNT(*) FROM processed_events;"
   ```

4. **Restart event listener**
   ```bash
   startEventListener();
   ```

### If Events Lost

1. **Reset cursor to earlier ledger**
   ```bash
   psql $DATABASE_URL -c "UPDATE event_cursors SET lastProcessedLedger = 100 WHERE contractId = '$VAULT_CONTRACT_ID';"
   ```

2. **Clear processed events (optional)**
   ```bash
   psql $DATABASE_URL -c "DELETE FROM processed_events WHERE contractId = '$VAULT_CONTRACT_ID';"
   ```

3. **Restart listener**
   ```bash
   stopEventListener();
   startEventListener();
   ```

## Success Criteria

✅ Migration applied successfully
✅ EventCursor table created
✅ ProcessedEvent table created
✅ Event listener starts without errors
✅ Events are processed and persisted
✅ No duplicate events
✅ Listener resumes on restart
✅ All tests passing
✅ No errors in logs
✅ Database performance acceptable

## Support

For issues or questions:
1. Check logs for error messages
2. Review database state
3. Refer to QUICK_REFERENCE.md
4. Refer to IMPLEMENTATION_DETAILS.md
5. Contact development team

## Rollback Timeline

- **Immediate**: Stop listener, rollback migration
- **5 minutes**: Verify rollback, check data
- **15 minutes**: Restart with previous version
- **30 minutes**: Full system verification

## Communication

### Before Deployment
- Notify team of deployment
- Schedule maintenance window if needed
- Prepare rollback plan

### During Deployment
- Monitor logs in real-time
- Check database performance
- Verify event processing

### After Deployment
- Confirm all systems operational
- Monitor for 24 hours
- Document any issues
- Update team on status
