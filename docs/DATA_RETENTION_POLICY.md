# Data Retention and Archival Policy

## Overview

This document defines the data retention, archival, and purge policies for all analytics and operational logs in the NeuroWealth Backend system. The policy ensures compliance readiness, reduces storage growth and cost, and clarifies ownership of the data lifecycle.

## Retention Windows by Data Type

### Operational Logs

| Data Type            | Table/Source        | Retention Period        | Archival           | Purge Method      |
| -------------------- | ------------------- | ----------------------- | ------------------ | ----------------- |
| Auth Nonces          | `auth_nonce`        | TTL-based (expiresAt)   | No                 | Automatic cleanup |
| Processed Events     | `processed_event`   | 90 days                 | Yes (audit chain)  | Scheduled job     |
| Dead Letter Events   | `dead_letter_event` | 30 days (RESOLVED only) | No                 | Scheduled job     |
| Agent Logs           | `agent_log`         | 60 days                 | Yes (audit chain)  | Scheduled job     |
| User Events (Stream) | `user_event`        | 7 days + 5000/user cap  | No                 | Scheduled job     |
| Audit Blocks         | `audit_block`       | 365 days                | Yes (cold storage) | Scheduled job     |
| Data Type | Table/Source | Retention Period | Archival | Purge Method |
|-----------|--------------|------------------|-----------|--------------|
| Auth Nonces | `auth_nonce` | TTL-based (expiresAt) | No | Automatic cleanup |
| Processed Events | `processed_event` | 90 days | Yes (audit chain) | Scheduled job |
| Dead Letter Events | `dead_letter_event` | 30 days (RESOLVED only) | No | Scheduled job |
| Agent Logs | `agent_log` | 60 days | Yes (audit chain) | Scheduled job |
| User Events (Stream) | `user_event` | 7 days + 5000/user cap | No | Scheduled job |
| Audit Blocks | `audit_block` | 365 days | Yes (cold storage) | Scheduled job |
| Admin Audit Logs | `admin_audit_logs` | 365 days (configurable) | Yes (audit chain anchor) | Scheduled job (#682) |

### Analytics Data

| Data Type               | Table/Source           | Retention Period | Archival         | Purge Method  |
| ----------------------- | ---------------------- | ---------------- | ---------------- | ------------- |
| Protocol Rates          | `protocol_rate`        | 180 days         | Yes (S3/Glacier) | Scheduled job |
| Yield Snapshots         | `yield_snapshot`       | 90 days          | Yes (S3/Glacier) | Scheduled job |
| Performance Attribution | `attribution_snapshot` | 365 days         | Yes (S3/Glacier) | Scheduled job |
| Strategy Metrics        | `strategy_metrics`     | 180 days         | Yes (S3/Glacier) | Scheduled job |
| Portfolio Risk Scores   | `portfolio_risk`       | 90 days          | No               | Scheduled job |

### Transaction Data

| Data Type         | Table/Source  | Retention Period         | Archival           | Purge Method  |
| ----------------- | ------------- | ------------------------ | ------------------ | ------------- |
| Transactions      | `transaction` | 7 years (tax compliance) | Yes (cold storage) | Never         |
| Positions         | `position`    | 7 years (tax compliance) | Yes (cold storage) | Never         |
| Outbox Operations | `outbox_op`   | 90 days (CONFIRMED)      | No                 | Scheduled job |

### User Data

| Data Type                | Table/Source              | Retention Period    | Archival          | Purge Method |
| ------------------------ | ------------------------- | ------------------- | ----------------- | ------------ |
| User Profiles            | `user`                    | Indefinite (active) | Yes (GDPR export) | On request   |
| API Keys                 | `api_key`                 | Indefinite (active) | No                | On deletion  |
| Notification Preferences | `notification_preference` | Indefinite          | No                | On deletion  |
| Sessions                 | `session`                 | 24 hours            | No                | TTL-based    |

## Archival Workflow

### Phase 1: Pre-Archival Validation

Before archiving any data, the system validates:

1. **Data Completeness**: All required fields are present
2. **Audit Chain Integrity**: Hashes match the audit chain
3. **Compliance Flags**: No legal holds or compliance flags are set
4. **Backup Confirmation**: At least one successful backup exists

### Phase 2: Data Redaction

Sensitive data is redacted before archival:

- **PII**: Email addresses, phone numbers masked (e.g., `j***@example.com`)
- **Secrets**: API keys, tokens completely removed
- **Wallet Data**: Private keys never archived; only public addresses retained
- **IP Addresses**: Last octet masked (e.g., `192.168.1.***`)

### Phase 3: Archival Process

1. **Export**: Data exported to compressed JSON lines format
2. **Encryption**: AES-256 encryption at rest
3. **Upload**: Uploaded to cold storage (S3 Glacier or equivalent)
4. **Indexing**: Metadata indexed in archival catalog
5. **Verification**: Upload integrity verified via checksum
6. **Purge**: Original data removed from hot database

### Phase 4: Retrieval

Archived data retrieval process:

1. **Request**: Submit retrieval request with justification
2. **Approval**: Requires admin or compliance approval
3. **Restore**: Data restored from cold storage (3-12 hour SLA)
4. **Audit**: Retrieval logged to audit trail

## Sensitive Data Handling

### Data Classification

| Classification  | Examples                         | Handling                                               |
| --------------- | -------------------------------- | ------------------------------------------------------ |
| **Critical**    | Private keys, seed phrases       | Never logged, encrypted at rest, strict access control |
| **Sensitive**   | API keys, auth tokens            | Masked in logs, encrypted at rest, need-to-know access |
| **PII**         | Email, phone, wallet addresses   | Redacted in archives, GDPR-compliant deletion          |
| **Operational** | Event logs, metrics              | Standard retention, no special handling                |
| **Public**      | Protocol rates, public addresses | No restrictions                                        |

### Redaction Rules

#### Log Redaction (#666)

Log payloads and Winston message streams are transformed prior to dispatch to any transport or storage engine:

```typescript
// Field deny-list: unconditionally replaced with '[REDACTED]'
const DENY_LIST_KEYS = [
  'password',
  'secret',
  'token',
  'authorization',
  'cookie',
]

// Redaction rules across string messages and object values:
// 1. Email: redact local-part, preserve domain (e.g., user@example.com -> ***@example.com)
// 2. Phone: mask full number (e.g., +1-555-123-4567 -> ***-***-****)
// 3. IP: mask host octet to preserve /24 subnet (e.g., 192.168.1.100 -> 192.168.1.***)
// 4. Wallet: mask Stellar & EVM addresses (e.g., GAAZ...CWN7, 0x71...976F)
// 5. Secret keys: redact Stellar secret keys (S...) to [REDACTED_SECRET_KEY]
// 6. Tokens: Slack (xoxb-), Stripe (sk-), Bearer, and 64-char hex strings masked
```

Scrubbing cannot be bypassed by debug log levels or sampling mechanisms, ensuring persistent operational logs adhere to data minimization under GDPR Article 5(1)(c) and CCPA.

### Audit Trail Requirements

All data lifecycle operations must be logged:

- **Creation**: Data creation timestamp and source
- **Access**: Who accessed data and when
- **Modification**: What changed and why
- **Archival**: When data was archived and where
- **Purge**: When data was purged and by whom
- **Retrieval**: When archived data was restored

## Ownership and Responsibilities

| Role                   | Responsibilities                                |
| ---------------------- | ----------------------------------------------- |
| **Data Engineer**      | Implement retention jobs, monitor storage usage |
| **Security Engineer**  | Define redaction rules, manage encryption keys  |
| **Compliance Officer** | Set retention periods, approve retrievals       |
| **DevOps Engineer**    | Manage archival storage, configure alerts       |
| **Database Admin**     | Execute purge operations, verify integrity      |

## Configuration

Environment variables for retention policy:

```env
# Retention Periods (days)
RETENTION_PROCESSED_EVENTS_DAYS=90
RETENTION_DEAD_LETTER_EVENTS_DAYS=30
RETENTION_AGENT_LOGS_DAYS=60
RETENTION_USER_EVENTS_DAYS=7
USER_EVENT_STREAM_MAX_PER_USER=5000
RETENTION_PROTOCOL_RATES_DAYS=180
RETENTION_YIELD_SNAPSHOTS_DAYS=90
RETENTION_ATTRIBUTION_DAYS=365

# Dry-run mode (logs counts without deleting)
DATA_RETENTION_DRY_RUN=false

# Archival Settings
ARCHIVAL_ENABLED=true
ARCHIVAL_STORAGE_PROVIDER=s3
ARCHIVAL_BUCKET=neurowealth-archive
ARCHIVAL_ENCRYPTION_KEY_ID=alias/neurowealth-archive-key
ARCHIVAL_RETENTION_YEARS=7

# Job Scheduling
RETENTION_INTERVAL_MS=86400000  # 24 hours
ARCHIVAL_INTERVAL_MS=604800000 # 7 days
```

## Dry-Run Mode

The data retention job supports a dry-run mode for safe testing and validation:

- **Enable**: Set `DATA_RETENTION_DRY_RUN=true`
- **Behavior**: Logs the number of rows that would be deleted per table without performing any deletions
- **Use cases**:
  - Validate retention policies before deployment
  - Estimate deletion impact without risk
  - Debug retention job behavior in production-like environments
  - Generate retention reports for compliance auditing

Dry-run mode applies to all retention tables:

- `auth_nonce` (expired nonces)
- `processed_event` (events older than retention window)
- `dead_letter_event` (RESOLVED entries older than retention window)
- `agent_log` (logs older than retention window)
- `user_event` (events older than retention window and per-user cap overages)

Logs include per-table counts (`wouldDelete`) and retention parameters (retention days, max per user for user events).

## Monitoring and Alerts

### Metrics to Monitor

- `retention_deletes_total` - Rows deleted by retention jobs
- `retention_last_run_timestamp_seconds` - Last successful run per table
- `archival_upload_total` - Successful archival uploads
- `archival_upload_failed_total` - Failed archival uploads
- `storage_usage_bytes` - Database storage by table
- `archival_storage_cost_monthly` - Monthly archival storage cost

### Alert Rules

| Alert                      | Condition                      | Severity |
| -------------------------- | ------------------------------ | -------- |
| Retention Job Failed       | Job fails 3 consecutive times  | Critical |
| Storage Growth Anomaly     | Storage grows >50% in 7 days   | Warning  |
| Archival Upload Failed     | Upload failure rate >10%       | Critical |
| Compliance Hold Set        | Legal hold flag set on data    | Critical |
| Retrieval Without Approval | Unauthorized retrieval attempt | Critical |

## Compliance Considerations

### GDPR

- Right to erasure: User data deleted within 30 days of request
- Data portability: User can export their data
- Consent tracking: All consent changes logged

### SOX

- Audit trail: All financial data changes logged
- Retention: Transaction data retained 7 years
- Access control: Role-based access to sensitive data

### PCI-DSS

- Card data: Never stored (not applicable for crypto)
- Encryption: All sensitive data encrypted at rest
- Access logs: All access logged and monitored

## Admin Audit Log Lifecycle & Legal Hold (#682)

### Append-Only Immutability
`admin_audit_logs` is guaranteed append-only at the PostgreSQL layer:
- **UPDATE**: Strictly forbidden for all roles via row-level trigger `trg_admin_audit_logs_append_only`.
- **DELETE**: The application role has no direct `DELETE` privilege. Retention can only call the bounded `public.purge_admin_audit_logs(ids, cutoff)` security-definer function; each batch is capped at 500 rows and anchored in the same transaction before deletion.

### Retention & Legal Hold
- **Configurable Window**: Default retention is 365 days (`RETENTION_ADMIN_AUDIT_LOGS_DAYS=365`). Keep this aligned with the database enforcement floor in `admin_audit_retention_control.retentionDays`.
- **Litigation / Legal Hold Override**: `ADMIN_AUDIT_LEGAL_HOLD=true` stops the worker. A persistent database hold in `admin_audit_retention_control.legalHold` blocks the purge function and trigger even if a caller sets the purge session flag. A transaction-local `neuro.legal_hold='true'` also blocks purging. Database operators control the persistent hold; the application role cannot change it.
- **Cryptographic Anchoring**: Expired logs are hashed and anchored to the `AuditBlock` chain via `anchorBeforeDelete` before pruning.

### Export Capability
- `GET /api/v1/admin/audit/export`: Paginated and filterable export endpoint (JSON/CSV) for compliance responses.
- **Self-Audited**: Every export request writes an `EXPORT_ADMIN_AUDIT_LOGS` audit row into `admin_audit_logs`.

## Implementation References

- **Retention Jobs**: `src/jobs/dataRetention.ts`, `src/jobs/adminAuditRetention.ts`
- **Audit Chain**: `src/audit/chain.ts`
- **Metrics**: `src/utils/metrics.ts`
- **Configuration**: `src/config/env.ts`
- **Admin Audit Export**: `src/routes/admin.ts` (`GET /api/v1/admin/audit/export`)

## Change Log

| Date       | Change                    | Author       |
| ---------- | ------------------------- | ------------ |
| 2024-09-28 | Initial policy definition | Backend Team |
| 2026-10-21 | Added Admin Audit Log append-only enforcement, retention, and export (#682) | Backend Team |
