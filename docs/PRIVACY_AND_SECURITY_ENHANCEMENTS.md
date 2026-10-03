# Privacy and Security Enhancements

This document covers three major security and compliance enhancements implemented for the Neurowealth platform:

1. **Privacy Erasure Workflows** (#489) - GDPR Right to be Forgotten compliance
2. **API Key Lifecycle Management** (#491) - Enhanced security for admin access
3. **Referral Fraud Detection** (#490) - Protection against referral program abuse

---

## 1. Privacy Erasure Workflows (#489)

### Overview

Complete GDPR Article 17 "Right to be Forgotten" implementation with approval workflow, comprehensive data deletion, and audit trail preservation.

### Design Principles

- **Explicit approval required** - No automatic deletion; all requests go through review
- **Transactional deletion** - All-or-nothing approach prevents partial deletions
- **Audit trail preserved** - Maintains compliance records even after user deletion
- **Financial record anonymization** - Tax lots and disposals anonymized, not deleted (regulatory requirement)
- **Irreversible operation** - Multiple safeguards prevent accidental execution

### Workflow States

```
                   create
PENDING ──────────────────────► approved/rejected
   │                                    │
   │                                    │
   │              approve                │
   └────────────────────────────────────┘
                    │
                    │ execute
                    ▼
              COMPLETED/FAILED
```

### API Endpoints

#### Create Erasure Request
```http
POST /api/admin/erasure/requests
Authorization: Bearer <admin-token>
Scope Required: write

Body:
{
  "userId": "uuid",
  "reason": "GDPR right to be forgotten request from user"
}

Response:
{
  "success": true,
  "data": {
    "id": "request-uuid",
    "userId": "user-uuid",
    "status": "PENDING",
    "requestedAt": "2026-09-28T17:00:00Z",
    "requestedBy": "admin@example.com"
  }
}
```

#### List Erasure Requests
```http
GET /api/admin/erasure/requests?status=PENDING&limit=50&offset=0
Authorization: Bearer <admin-token>
Scope Required: read

Response:
{
  "success": true,
  "data": {
    "requests": [...],
    "total": 10
  }
}
```

#### Preview Erasure
```http
GET /api/admin/erasure/preview/:userId
Authorization: Bearer <admin-token>
Scope Required: read

Response:
{
  "success": true,
  "data": {
    "deletedRecords": {
      "sessions": 5,
      "positions": 3,
      "transactions": 50,
      "agentLogs": 100,
      "webhookSubscriptions": 2,
      ...
    },
    "anonymizedRecords": {
      "costBasisLots": 10,
      "lotDisposals": 5,
      "portfolioAttributions": 2
    },
    "preservedRecords": {
      "adminAuditLogs": 0
    }
  }
}
```

#### Approve Erasure Request
```http
POST /api/admin/erasure/requests/:id/approve
Authorization: Bearer <admin-token>
Scope Required: super

Response:
{
  "success": true,
  "data": {
    "id": "request-uuid",
    "status": "APPROVED",
    "approvedBy": "senior-admin@example.com",
    "approvedAt": "2026-09-28T18:00:00Z"
  }
}
```

#### Reject Erasure Request
```http
POST /api/admin/erasure/requests/:id/reject
Authorization: Bearer <admin-token>
Scope Required: super

Body:
{
  "rejectionReason": "Duplicate request - already processed under ticket #123"
}
```

#### Execute Erasure (IRREVERSIBLE)
```http
POST /api/admin/erasure/requests/:id/execute
Authorization: Bearer <admin-token>
Scope Required: super

Response:
{
  "success": true,
  "data": {
    "userId": "user-uuid",
    "walletAddress": "GA...",
    "deletedRecords": { ... },
    "anonymizedRecords": { ... },
    "preservedRecords": { ... }
  }
}
```

### Data Retention Policy

The system enforces automated retention policies for system data:

| Data Type | Default Retention | Configurable |
|-----------|------------------|--------------|
| Auth nonces | Deleted on expiry | No |
| Processed events | 90 days | Yes (`RETENTION_PROCESSED_EVENTS_DAYS`) |
| Dead letter events (RESOLVED) | 30 days | Yes (`RETENTION_DEAD_LETTER_EVENTS_DAYS`) |
| Agent logs | 60 days | Yes (`RETENTION_AGENT_LOGS_DAYS`) |

### What Gets Deleted

- User profile data (name, email, phone, avatar)
- All sessions and authentication tokens
- Positions and yield snapshots
- Transactions (non-financial metadata)
- Agent logs and rebalance history
- Webhook subscriptions and deliveries
- Fiat orders
- Recurring deposit plans
- Alert rules
- Savings goals
- Published strategies and follows
- Sub-account relationships

### What Gets Anonymized (Not Deleted)

- **Cost basis lots** - Required for tax purposes; userId set to sentinel value
- **Lot disposals** - Capital gains records; userId anonymized
- **Portfolio attributions** - Historical performance data; userId anonymized

### What Gets Preserved

- **Admin audit logs** - Compliance requirement; adminKeyId nullified but logs kept
- **Referral conversion records** - Aggregate fraud metrics preserved

### Testing

```bash
npm test tests/unit/compliance/privacyErasure.test.ts
```

Tests cover:
- Request creation and validation
- Approval/rejection workflow
- Complete execution with transaction rollback on failure
- Edge cases (duplicate requests, non-existent users, invalid states)
- Preview functionality

---

## 2. API Key Lifecycle Management (#491)

### Overview

Enhanced admin API key system with comprehensive lifecycle management including creation, expiry, rotation, and least-privilege scope enforcement.

### Features

#### Existing Features (Enhanced)
- **Scoped permissions** - Granular access control per endpoint
- **Bcrypt hashing** - Secure token storage
- **SHA-256 token prefix** - Fast candidate lookup before expensive bcrypt compare
- **Last-used tracking** - Audit trail of key usage
- **Revocation support** - Immediate key invalidation

#### New Features (#491)
- **✓ Expiration enforcement** - Keys can have `expiresAt` timestamp
- **✓ Key rotation** - One-step rotation preserves scopes/role, revokes old key
- **✓ Audit logging** - All key operations logged to `AdminAuditLog`
- **✓ Comprehensive testing** - Lifecycle and security scenarios covered

### Available Scopes

```typescript
const ADMIN_SCOPES = [
  'read',           // Read-only operations
  'write',          // Write operations
  'wallet',         // Wallet operations
  'agent',          // Agent control
  'metrics:read',   // Metrics access
  'dlq:read',       // Dead letter queue read
  'dlq:write',      // Dead letter queue write
  'backfill:write', // Data backfill operations
  'keys:read',      // API key listing
  'keys:write',     // API key management
  'fiat:read',      // Fiat provider read
  'fiat:write',     // Fiat provider write
  'outbox:read',    // Outbox operations read
  'outbox:write',   // Outbox operations write
  'super',          // All scopes (includes all above)
]
```

### API Endpoints

#### Create API Key
```http
POST /api/admin/keys
Authorization: Bearer <admin-token>
Scope Required: keys:write

Body:
{
  "name": "CI/CD Pipeline Key",
  "role": "AUTOMATION",
  "scopes": ["read", "metrics:read"],
  "expiresAt": "2027-09-28T00:00:00Z"  // Optional
}

Response:
{
  "success": true,
  "data": {
    "id": "key-uuid",
    "name": "CI/CD Pipeline Key",
    "role": "AUTOMATION",
    "scopes": ["read", "metrics:read"],
    "expiresAt": "2027-09-28T00:00:00Z",
    "token": "a1b2c3d4...", // ⚠️ SHOWN ONCE - STORE SECURELY
    "warning": "Store this token securely. It will not be shown again."
  }
}
```

#### List API Keys
```http
GET /api/admin/keys
Authorization: Bearer <admin-token>
Scope Required: keys:read

Response:
{
  "success": true,
  "data": [
    {
      "id": "key-uuid",
      "name": "CI/CD Pipeline Key",
      "role": "AUTOMATION",
      "scopes": ["read"],
      "expiresAt": "2027-09-28T00:00:00Z",
      "revokedAt": null,
      "lastUsedAt": "2026-09-28T12:30:00Z",
      "createdAt": "2026-01-01T00:00:00Z"
    }
  ]
}
```

#### Rotate API Key
```http
POST /api/admin/keys/:id/rotate
Authorization: Bearer <admin-token>
Scope Required: keys:write

Response:
{
  "success": true,
  "data": {
    "id": "new-key-uuid",
    "name": "CI/CD Pipeline Key (rotated)",
    "role": "AUTOMATION",
    "scopes": ["read", "metrics:read"],  // Same scopes as old key
    "expiresAt": "2027-09-28T00:00:00Z",
    "token": "e5f6g7h8...", // ⚠️ SHOWN ONCE - STORE SECURELY
    "warning": "Store this token securely. It will not be shown again.",
    "oldKeyId": "old-key-uuid",
    "oldKeyStatus": "revoked"
  }
}
```

#### Revoke API Key
```http
DELETE /api/admin/keys/:id
Authorization: Bearer <admin-token>
Scope Required: keys:write

Response:
{
  "success": true,
  "data": {
    "id": "key-uuid",
    "status": "revoked"
  }
}
```

### Rotation Best Practices

1. **Regular rotation schedule** - Rotate keys every 90 days
2. **Incident response** - Rotate immediately if compromise suspected
3. **Testing** - Test new key before revoking old (rotation provides grace period)
4. **Documentation** - Update runbooks with new key locations
5. **Monitoring** - Alert on key expiration (30/7/1 days before)

### Authentication Flow

```
1. Request arrives with Bearer token
   ↓
2. SHA-256 hash computed for fast lookup
   ↓
3. Candidates fetched (non-revoked, non-expired)
   ↓
4. Bcrypt compare against candidates
   ↓
5. Match found → lastUsedAt updated → next()
   No match → 403 Forbidden
```

### Security Features

- **Token never stored in plaintext** - Only bcrypt hash persisted
- **Fast candidate filtering** - SHA-256 prefix prevents full table scan
- **Expiration enforcement** - Expired keys rejected even if hash matches
- **Revocation takes effect immediately** - No grace period
- **Audit trail** - All operations logged with IP, user-agent, timestamp

### Testing

```bash
npm test tests/unit/middleware/adminAuth.test.ts
npm test tests/unit/middleware/apiKeyLifecycle.test.ts
```

Tests cover:
- Key creation with/without expiry
- Expiration enforcement
- Revocation logic
- Rotation workflow
- Scope validation
- Last-used tracking

---

## 3. Referral Fraud Detection (#490)

### Overview

Comprehensive fraud detection and manual review system for the referral rewards program, protecting against self-referral, duplicate accounts, and coordinated abuse.

### Fraud Detection Features

#### Automated Checks

1. **Duplicate Identifier Detection**
   - Duplicate wallet address (+100 risk score) → **BLOCKS**
   - Duplicate email (+50 risk score)
   - Duplicate phone (+50 risk score)

2. **IP Address Analysis**
   - Shared IP between referrer and referred (+40 risk score)
   - Captures IP from sessions for cross-referencing

3. **Velocity Monitoring**
   - ≥5 conversions in 24h from same referrer (+30 risk score)
   - Detects coordinated farming attempts

4. **Rapid Activation Pattern**
   - ≥3 activations in 7 days from same referrer (+40 risk score)
   - Flags suspicious deposit patterns

5. **Self-Referral Prevention**
   - Automatic blocking (no risk score, immediate rejection)
   - Prevents owner from referring their own account

### Risk Scoring

```
Score < 80:  Auto-approve, conversion created normally
Score 80-99: Manual review required, conversion created with flag
Score ≥ 100: Auto-block, conversion rejected, alert sent
```

### Fraud Flags

```typescript
enum ReferralFraudFlag {
  SELF_REFERRAL_BLOCKED          // Owner referring themselves
  DUPLICATE_WALLET               // Same wallet as existing user
  DUPLICATE_EMAIL                // Same email as existing user
  DUPLICATE_PHONE                // Same phone as existing user
  SUSPICIOUS_VELOCITY            // Too many referrals too fast
  SAME_IP_ADDRESS                // Shared IP with referrer
  RAPID_ACTIVATION               // Too many activations too fast
  SUSPICIOUS_WITHDRAWAL_PATTERN  // Reserved for future use
}
```

### Manual Review Workflow

```
Referral Created (Score ≥ 80)
         │
         ├─→ manualReviewRequired = true
         │
         ▼
    Review Queue
         │
         ├─→ Approve → manualReviewRequired = false → Payout proceeds
         │
         └─→ Reject → manualReviewRejected = true → Payout blocked
```

### API Endpoints

#### List Conversions for Review
```http
GET /api/admin/referrals/review
Authorization: Bearer <admin-token>
Scope Required: read

Response:
{
  "success": true,
  "data": [
    {
      "id": "conversion-uuid",
      "status": "PENDING",
      "fraudCheckScore": 90,
      "fraudCheckFlags": ["DUPLICATE_EMAIL", "SAME_IP_ADDRESS"],
      "fraudCheckDetails": {
        "sharedIps": ["192.168.1.100"],
        "duplicateEmail": true
      },
      "manualReviewRequired": true,
      "referralCode": {
        "code": "ABC12345",
        "owner": {
          "walletAddress": "GXYZ...",
          "email": "owner@example.com",
          "createdAt": "2025-01-01T00:00:00Z"
        }
      },
      "referredUser": {
        "walletAddress": "GABC...",
        "email": "referred@example.com",
        "createdAt": "2026-09-28T00:00:00Z"
      },
      "createdAt": "2026-09-28T00:00:00Z"
    }
  ]
}
```

#### Approve Referral Conversion
```http
POST /api/admin/referrals/review/:id/approve
Authorization: Bearer <admin-token>
Scope Required: write

Response:
{
  "success": true,
  "message": "Referral conversion approved"
}
```

#### Reject Referral Conversion
```http
POST /api/admin/referrals/review/:id/reject
Authorization: Bearer <admin-token>
Scope Required: write

Body:
{
  "rejectionReason": "Confirmed duplicate accounts - user admitted to creating multiple accounts"
}

Response:
{
  "success": true,
  "message": "Referral conversion rejected"
}
```

### Payout Protection

The payout job automatically skips conversions that:
- Require manual review (`manualReviewRequired: true`)
- Have been rejected (`manualReviewRejected: true`)

```typescript
// From payoutActivatedConversions()
const pending = await db.referralConversion.findMany({
  where: {
    status: ReferralStatus.ACTIVATED,
    manualReviewRequired: false,  // ← Only approved conversions
    manualReviewRejected: false,   // ← Skip rejected ones
  },
  ...
})
```

### Alerting

Fraud detection triggers alerts at different severity levels:

| Event | Severity | Dedup Key |
|-------|----------|-----------|
| Attribution blocked (score ≥ 100) | `warning` | `referral-fraud-{userId}` |
| Manual review required (score 80-99) | `info` | `referral-review-{conversionId}` |
| Payout failed | `warning` | `referral-payout-{conversionId}-{leg}` |

### Audit Trail

All fraud checks are recorded:
- `fraudCheckScore` - Numeric risk score
- `fraudCheckFlags` - Array of triggered flags
- `fraudCheckDetails` - JSON with specific findings
- `reviewedBy` - Admin who reviewed (if applicable)
- `reviewedAt` - Timestamp of review
- `rejectionReason` - Explanation for rejection

### Testing

```bash
npm test tests/unit/referral/service.test.ts
npm test tests/unit/referral/fraudDetection.test.ts
```

Tests cover:
- All fraud detection patterns
- Risk score calculation
- Auto-block vs manual review thresholds
- Approval/rejection workflow
- Payout filtering logic

### Operational Runbook

#### Daily Review Process

1. Check review queue:
   ```bash
   GET /api/admin/referrals/review
   ```

2. For each flagged conversion:
   - Review fraud flags and score
   - Check user creation dates
   - Verify IP addresses aren't VPN/proxy
   - Cross-reference with previous rejections

3. Approve legitimate referrals:
   ```bash
   POST /api/admin/referrals/review/{id}/approve
   ```

4. Reject fraudulent referrals with reason:
   ```bash
   POST /api/admin/referrals/review/{id}/reject
   Body: { "rejectionReason": "..." }
   ```

#### Metrics to Monitor

- Daily conversion creation rate
- Fraud detection hit rate
- Manual review queue depth
- Average time to review
- Rejection rate by flag type

---

## Environment Variables

### Privacy Erasure
No additional environment variables - uses existing retention configuration.

### API Key Lifecycle
No additional environment variables - expiry is per-key in database.

### Referral Fraud Detection
```bash
# Existing referral configuration (already present)
REFERRAL_MIN_ACTIVATION_DEPOSIT=10
REFERRAL_OWNER_REWARD=5
REFERRAL_REFERRED_REWARD=5
REFERRAL_REWARD_ASSET=USDC
REFERRAL_PAYOUT_INTERVAL_MS=120000
```

---

## Database Migrations

### Privacy Erasure
```bash
prisma/migrations/20260928171923_add_erasure_request/
```

### Referral Fraud Detection
```bash
prisma/migrations/20260928172500_add_referral_fraud_detection/
```

### Apply Migrations
```bash
npx prisma migrate deploy
```

---

## Security Considerations

### Privacy Erasure
- **Requires `super` scope** for approval and execution
- **Irreversible operation** - no rollback capability
- **Transaction-wrapped** - prevents partial deletions
- **Alert on failure** - immediate notification if execution fails

### API Key Lifecycle
- **Tokens never logged** - only shown once at creation
- **Rotation preserves access** - no downtime during key rotation
- **Audit trail complete** - all operations logged with context
- **Scope enforcement strict** - `super` scope cannot be bypassed

### Referral Fraud Detection
- **Non-blocking for users** - fraud checks never fail signup
- **Privacy-preserving** - no exposed PII in fraud details
- **Alert on blocks** - suspicious patterns immediately flagged
- **Manual review required** - humans make final decision on edge cases

---

## Compliance

### GDPR (Privacy Erasure)
- ✓ Right to be forgotten (Article 17)
- ✓ Right to rectification (Article 16) - via existing update endpoints
- ✓ Right to data portability (Article 20) - via existing export endpoints
- ✓ Audit trail (Article 30) - all operations logged

### SOC 2 (API Key Lifecycle)
- ✓ Access control (CC6.1)
- ✓ Logical access (CC6.2)
- ✓ Encryption at rest (CC6.7)
- ✓ Audit logging (CC7.1)

### PCI DSS (Fraud Detection)
- ✓ Fraud detection and prevention (Requirement 11.4)
- ✓ User activity logging (Requirement 10)
- ✓ Security incident procedures (Requirement 12.10)

---

## Monitoring and Alerts

### Key Metrics

#### Privacy Erasure
- Erasure requests created per day
- Average time from request to execution
- Failure rate
- Preview vs actual deletion variance

#### API Key Lifecycle
- Keys nearing expiration (30/7/1 days)
- Keys with no recent use (> 90 days)
- Failed authentication attempts
- Rotation frequency

#### Referral Fraud Detection
- Fraud detection hit rate
- Manual review queue depth
- Average review time
- Blocked conversions per day
- False positive rate (rejections later approved)

### Recommended Alerts

```yaml
# Grafana alert examples

- alert: ErasureExecutionFailure
  expr: erasure_execution_failures_total > 0
  for: 1m
  severity: critical

- alert: ApiKeyExpiringON
  expr: admin_keys_expiring_in_days{days="7"} > 0
  for: 1d
  severity: warning

- alert: HighReferralFraudRate
  expr: referral_fraud_blocks_total / referral_conversions_total > 0.2
  for: 5m
  severity: warning

- alert: ReferralReviewQueueBacklog
  expr: referral_manual_review_pending > 10
  for: 1h
  severity: info
```

---

## Support and Troubleshooting

### Common Issues

#### Privacy Erasure

**Issue:** Erasure request stuck in APPROVED state
**Solution:** Check logs for transaction failures. Execute with `executeErasure(requestId)` - safe to retry (idempotent).

**Issue:** Preview shows different counts than execution
**Solution:** Normal - data may be created between preview and execution.

#### API Key Lifecycle

**Issue:** Token authentication fails after rotation
**Solution:** Verify new token was saved correctly. Old token is immediately revoked.

**Issue:** Key expires without warning
**Solution:** Check `expiresAt` field. Set up monitoring alerts for expiring keys.

#### Referral Fraud Detection

**Issue:** Legitimate user flagged for manual review
**Solution:** Review fraud details, approve via `/referrals/review/:id/approve`.

**Issue:** Fraudulent conversions getting through
**Solution:** Review fraud thresholds in `checkReferralFraud()`. Consider lowering auto-approve threshold.

---

## Implementation Checklist

### Issue #489: Privacy Erasure
- [x] Created `ErasureRequest` model in Prisma schema
- [x] Implemented erasure service (`src/compliance/privacyErasure.ts`)
- [x] Added admin routes for CRUD operations
- [x] Created comprehensive test suite
- [x] Added audit logging
- [x] Documented workflow and API

### Issue #491: API Key Lifecycle
- [x] Enhanced existing key model with expiration support
- [x] Implemented key rotation endpoint
- [x] Added expiration enforcement in middleware
- [x] Created lifecycle test suite
- [x] Enhanced audit logging
- [x] Documented rotation procedures

### Issue #490: Referral Fraud Detection
- [x] Created fraud detection function
- [x] Enhanced `ReferralConversion` model with fraud fields
- [x] Implemented manual review workflow
- [x] Added admin review endpoints
- [x] Updated payout job to skip flagged conversions
- [x] Created fraud detection test suite
- [x] Documented fraud patterns and procedures

---

## Future Enhancements

### Privacy Erasure
- [ ] Automated backup verification before execution
- [ ] Data export bundle generation before deletion
- [ ] Multi-region erasure coordination
- [ ] Scheduled erasure execution (time-delay for "cooling off")

### API Key Lifecycle
- [ ] Automated expiration warnings (email notifications)
- [ ] Key usage analytics dashboard
- [ ] IP allowlist per key
- [ ] Rate limiting per key (not just per scope)

### Referral Fraud Detection
- [ ] Machine learning fraud scoring
- [ ] Device fingerprinting integration
- [ ] Behavioral analysis (time-to-deposit, withdrawal patterns)
- [] Network graph analysis (referral chains)
- [ ] Integration with external fraud databases

---

## References

- [GDPR Article 17 - Right to Erasure](https://gdpr-info.eu/art-17-gdpr/)
- [NIST SP 800-63B - Digital Identity Guidelines](https://pages.nist.gov/800-63-3/sp800-63b.html)
- [OWASP API Security Top 10](https://owasp.org/API-Security/editions/2023/en/0x11-t10/)
- [Referral Program Documentation](./REFERRAL_PROGRAM.md)
