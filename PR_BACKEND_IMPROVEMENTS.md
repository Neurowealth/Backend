# Backend Improvements: Data Retention, Notification Preferences, Queue Metrics, and AI Safety

## Summary

This PR implements four major improvements to the Backend system:

1. **Data Retention and Archival Policy** (#518) - Comprehensive policy for analytics and operational logs
2. **Notification Preference Management** (#519) - Improved user notification settings and unsubscribe flows
3. **Queue Health Metrics** (#520) - Real-time metrics for queue lag, worker saturation, and throughput
4. **AI Prompt and Tool Policy** (#521) - Safe defaults and guardrails for AI agent operations

## Changes

### #518: Data Retention and Archival Policy

**Files Added:**
- `docs/DATA_RETENTION_POLICY.md` - Comprehensive retention policy documentation

**Key Features:**
- Defined retention windows for all data types (operational logs, analytics, transactions, user data)
- Documented archival workflow with validation, redaction, and retrieval processes
- Specified sensitive data handling and redaction rules
- Clarified ownership and responsibilities for data lifecycle
- Added configuration references and monitoring requirements

**Retention Windows:**
- Auth Nonces: TTL-based (expiresAt)
- Processed Events: 90 days with audit chain archival
- Dead Letter Events: 30 days (RESOLVED only)
- Agent Logs: 60 days with audit chain archival
- User Events: 7 days + 5000/user cap
- Protocol Rates: 180 days with S3/Glacier archival
- Yield Snapshots: 90 days with S3/Glacier archival
- Transactions: 7 years (tax compliance)

### #519: Notification Preference Management

**Files Added:**
- `src/notifications/types.ts` - TypeScript types for notification preferences
- `src/notifications/service.ts` - Service for managing preferences and unsubscribes
- `docs/NOTIFICATION_PREFERENCES.md` - API contract and documentation

**Key Features:**
- Comprehensive preference model supporting Telegram, WhatsApp, Email, and SMS
- Per-channel and per-category preference controls
- Quiet hours configuration with timezone support
- Frequency control (immediate, daily, weekly)
- Secure unsubscribe flow with token-based verification
- Complete audit trail for all preference changes
- GDPR and CAN-SPAM compliance features

**API Endpoints:**
- `GET /api/v1/notifications/preferences` - Get user preferences
- `PUT /api/v1/notifications/preferences` - Update preference
- `POST /api/v1/notifications/enable-channel` - Enable all notifications for channel
- `POST /api/v1/notifications/disable-channel` - Disable all notifications for channel
- `POST /api/v1/notifications/unsubscribe` - Process unsubscribe request
- `GET /api/v1/notifications/audit-log` - Get preference audit trail

### #520: Queue Health Metrics

**Files Modified:**
- `src/utils/metrics.ts` - Added queue health metrics

**Files Added:**
- `docs/QUEUE_HEALTH_METRICS.md` - Comprehensive metrics documentation

**Key Features:**
- Queue lag metrics (age of oldest item)
- Queue depth metrics (number of items)
- Queue throughput metrics (items per second)
- Worker saturation metrics (utilization percentage)
- Worker active/idle count metrics
- Worker processing duration histogram
- Queue processing error tracking
- Queue blocked time tracking

**New Metrics:**
- `queue_lag_seconds` - Time oldest item has been waiting
- `queue_depth` - Current number of items in queue
- `queue_throughput_per_second` - Items processed per second
- `worker_saturation` - Worker utilization percentage
- `worker_active_count` - Currently active workers
- `worker_idle_count` - Currently idle workers
- `worker_processing_duration_seconds` - Task processing duration
- `queue_processing_errors_total` - Processing error count
- `queue_blocked_seconds` - Time queue has been blocked

**Alert Thresholds:**
- Queue lag: Warning > 60s, Critical > 300s
- Queue depth: Warning > 1000, Critical > 5000
- Worker saturation: Warning > 70%, Critical > 90%
- Processing duration: Warning p95 > 30s, Critical p95 > 60s

### #521: AI Prompt and Tool Policy

**Files Added:**
- `docs/AI_PROMPT_AND_TOOL_POLICY.md` - Comprehensive AI safety policy

**Key Features:**
- Safe prompt defaults with explicit constraints
- Tool classification by risk level (safe, medium, high-risk)
- Pre-invocation guardrails and validation
- Post-invocation logging and sanitization
- External call validation and rate limiting
- Failure and fallback paths for all operations
- Comprehensive audit trail for agent decisions

**Tool Categories:**
- **Safe Tools** (no approval): get_portfolio, get_positions, get_protocol_rates, explain_strategy
- **Medium-Risk Tools** (confirmation): suggest_rebalance, analyze_risk, estimate_gas
- **High-Risk Tools** (2FA approval): execute_transaction, withdraw, transfer, approve, sign_message

**Guardrails:**
- Input validation with prohibited pattern detection
- Output sanitization for sensitive data
- External service whitelisting
- Rate limiting per service
- Timeout and retry policies
- Fallback to rule-based parser on AI failure

## Testing

### Unit Tests Required

- [ ] Notification preference service tests
- [ ] Unsubscribe token generation and verification
- [ ] Quiet hours timezone calculations
- [ ] Queue metrics recording functions
- [ ] Tool invocation guardrails
- [ ] Prompt output sanitization

### Integration Tests Required

- [ ] Preference update → audit log → notification behavior
- [ ] Unsubscribe flow with token verification
- [ ] Queue metrics collection from database
- [ ] Tool execution with guardrails
- [ ] External call validation and rate limiting

## Configuration

### Environment Variables Added

```env
# Data Retention
RETENTION_PROTOCOL_RATES_DAYS=180
RETENTION_YIELD_SNAPSHOTS_DAYS=90
RETENTION_ATTRIBUTION_DAYS=365
ARCHIVAL_ENABLED(true)
ARCHIVAL_STORAGE_PROVIDER=s3

# Queue Metrics
QUEUE_METRICS_INTERVAL_MS=15000
QUEUE_LAG_WARNING_SECONDS=60
QUEUE_LAG_CRITICAL_SECONDS=300
QUEUE_DEPTH_WARNING=1000
QUEUE_DEPTH_CRITICAL=5000
WORKER_SATURATION_WARNING=70
WORKER_SATURATION_CRITICAL=90

# AI Safety
TOOL_EXECUTION_TIMEOUT_MS=30000
TOOL_MAX_RETRIES=3
TOOL_REQUIRE_2FA_FOR_HIGH_RISK=true
FALLBACK_TO_RULE_BASED=true
```

## Documentation

- [x] Data Retention Policy (`docs/DATA_RETENTION_POLICY.md`)
- [x] Notification Preferences (`docs/NOTIFICATION_PREFERENCES.md`)
- [x] Queue Health Metrics (`docs/QUEUE_HEALTH_METRICS.md`)
- [x] AI Prompt and Tool Policy (`docs/AI_PROMPT_AND_TOOL_POLICY.md`)

## Breaking Changes

None. All changes are additive or documentation-only.

## Migration Required

### Database Schema Changes

The following tables need to be added to support notification preferences:

```prisma
model NotificationPreference {
  id          String   @id @default(uuid())
  userId      String
  channel     String
  category    String
  enabled     Boolean  @default(true)
  quietHours  Json?
  frequency   String?
  updatedAt   DateTime @default(now())
  updatedBy   String   @default("user")

  user User @relation(fields: [userId], references: [id])

  @@unique([userId, channel, category])
}

model NotificationPreferenceAuditLog {
  id            String   @id @default(uuid())
  userId        String
  action        String
  channel       String
  category      String
  previousValue Boolean
  newValue      Boolean
  changedBy     String
  changedAt     DateTime @default(now())
  metadata      Json?

  user User @relation(fields: [userId], references: [id])
}

model AgentToolInvocation {
  id          String   @id @default(uuid())
  toolName    String
  userId      String
  parameters  Json
  result      Json?
  durationMs  Int
  approved    Boolean
  timestamp   DateTime @default(now())
  ipAddress   String?
  userAgent   String?

  user User @relation(fields: [userId], references: [id])
}
```

## Checklist

- [x] Code follows project style guidelines
- [x] Self-review completed
- [x] Documentation updated
- [x] No breaking changes
- [ ] Unit tests written
- [ ] Integration tests written
- [ ] Database migration created
- [ ] Environment variables documented
- [ ] Security review completed

## Related Issues

Closes #518
Closes #519
Closes #520
Closes #521
