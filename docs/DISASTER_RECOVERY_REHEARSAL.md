# Disaster Recovery Rehearsal & Backup Validation Policy

## Overview

This document establishes the official Disaster Recovery (DR) rehearsal checklist, backup validation procedures, and critical service recovery flows for the NeuroWealth Backend.

---

## 1. Backup Scope & Retention Policy

### Backup Scope

| Resource             | Scope / Items Included                                         | Backup Type                               | Frequency                         | RPO Target   | RTO Target   |
| -------------------- | -------------------------------------------------------------- | ----------------------------------------- | --------------------------------- | ------------ | ------------ |
| Primary Database     | PostgreSQL schema, transactional data, user tables, audit logs | Automated Snapshots + WAL Archiving       | Continuous (WAL) / Daily Snapshot | < 15 minutes | < 1 hour     |
| Key Custody          | Wallet encryption keys, JWT seeds, API secrets                 | Secret Manager Versioning / Offline Vault | On creation / rotation            | < 0 minutes  | < 15 minutes |
| Redis Cache & Queues | Outbox operations, DLQ metadata, rate limits                   | RDB Snapshots                             | Hourly                            | < 1 hour     | < 30 minutes |
| System Configuration | Deployment manifests, env templates, app configs               | Git repository + Config Store             | Version controlled                | < 0 minutes  | < 15 minutes |

### Retention Windows

- **Daily Database Snapshots**: Retained for 30 days.
- **Monthly Database Snapshots**: Retained for 365 days.
- **Audit Chains & Compliance Data**: Retained for 7 years in cold storage (per `DATA_RETENTION_POLICY.md`).
- **WAL Logs**: Retained for 14 days to support point-in-time recovery (PITR).

---

## 2. Recovery Decision Points & SLA

### Key Decision Matrix

| Trigger Event             | Initial Assessment            | Action / Decision                            | Decision Owner         |
| ------------------------- | ----------------------------- | -------------------------------------------- | ---------------------- |
| Primary DB Unreachable    | Connection timeout > 3 mins   | Failover to Read Replica or Restore PITR     | Database Administrator |
| Data Corruption Detected  | Corrupted block/row count > 0 | Freeze write traffic & initiate PITR restore | Incident Commander     |
| Regional Outage           | Full cloud region failure     | Activate secondary region failover           | Infrastructure Lead    |
| Encryption Key Compromise | Unauthorized key access       | Key rotation + database re-encryption        | Security Lead          |

### Target Recovery Metrics

- **RPO (Recovery Point Objective)**: Maximum allowable data loss: **15 minutes**.
- **RTO (Recovery Time Objective)**: Maximum allowable service downtime: **60 minutes**.

---

## 3. Owner Assignments & Responsibilities

| Role                         | Primary Owner        | Secondary Owner     | Responsibilities                                                                |
| ---------------------------- | -------------------- | ------------------- | ------------------------------------------------------------------------------- |
| Incident Commander (IC)      | DevOps Lead          | Platform Lead       | Coordinates DR response, manages communications, authorizes failover.           |
| Database Administrator (DBA) | Lead DBA             | Sr Backend Engineer | Manages database snapshots, executes PITR restore, validates schema integrity.  |
| Infrastructure Lead          | Cloud Architect      | DevOps Engineer     | Handles DNS failover, secret provisioning, and container cluster redeploy.      |
| Security Lead                | CISO / Security Lead | Compliance Officer  | Verifies key material integrity, audits data access, clears production restart. |

---

## 4. Disaster Recovery Rehearsal Checklist

### Phase 1: Pre-Rehearsal Preparation

- [ ] Declare DR rehearsal window and notify engineering & ops teams.
- [ ] Confirm latest automated snapshot exists and pass integrity check.
- [ ] Provision isolated sandbox environment for DR rehearsal (do not run against production).
- [ ] Verify secret manager keys (`WALLET_ENCRYPTION_KEY`, `DATABASE_URL`) in test environment.

### Phase 2: Execution & Restore Flow

- [ ] **Step 1**: Trigger simulated failure (e.g., terminate primary DB instance in test sandbox).
- [ ] **Step 2**: Restore PostgreSQL database from latest snapshot or WAL point-in-time.
- [ ] **Step 3**: Verify database schema migrations and run `npx prisma migrate status`.
- [ ] **Step 4**: Validate wallet key decryption sanity check using test wallet payloads.
- [ ] **Step 5**: Clear/warm Redis queue states and verify outbox processing capability.
- [ ] **Step 6**: Start application backend instances and execute `scripts/smoke-health.sh`.

### Phase 3: Validation & Sign-off

- [ ] Execute automated validation script: `npx ts-node scripts/validate-backup-restore.ts`.
- [ ] Verify data completeness and count checks against pre-failure metrics.
- [ ] Measure total RTO and RPO achieved during rehearsal.
- [ ] Document rehearsal outcome in the incident post-mortem log.
- [ ] Obtain sign-off from Incident Commander and Security Lead.
- [ ] On Testnet, complete a signer dual-active rehearsal with zero failed
      payments; attach public transaction hashes only.
- [ ] Run `npm run verify:signer-rotation` with public signer/sponsor addresses
      and confirm balances plus `numSponsoring`/`numSponsored` remain intact.
- [ ] Exercise the break-glass rollback before removing either signer.

---

## 5. Automated Backup & Restore Validation and CI Rehearsal (#681)

Disaster recovery backup and restore validation is automated via scheduled CI and monitored continuously through Prometheus metrics.

### Continuous CI Validation Workflow

Automated backup restore validation runs via GitHub Actions workflow [`.github/workflows/dr-backup-restore-validation.yml`](../.github/workflows/dr-backup-restore-validation.yml):

- **Cadence**: Nightly at 02:00 UTC (`0 2 * * *`) and on-demand via `workflow_dispatch`.
- **Sandbox Environment**: Provisions an isolated disposable PostgreSQL service container (`postgres:15`) on port 5432.
- **Validation Pipeline**:
  1. Deploys current migrations (`npx prisma migrate deploy`).
  2. Generates database snapshot archive via `pg_dump`.
  3. Recreates clean scratch database and executes full restore via `psql`.
  4. Runs `npx prisma migrate status` ensuring zero migration drift and zero unapplied migrations.
  5. Executes rehearsal harness (`scripts/validate-backup-restore.ts`) to spot-check row counts, table accessibility, and wallet encryption keys.
  6. Measures and records rehearsal duration (`durationMs`).
  7. Publishes `dr-rehearsal-report.json` as a build artifact (retained for 30 days).

### Rehearsal Status Tracking & Metrics

Each successful rehearsal updates the Prometheus gauge:

- **Metric**: `dr_rehearsal_last_success_timestamp`
- **Type**: Gauge (Unix timestamp in seconds)
- **Scrape Endpoint**: `GET /metrics`

The CI workflow runs in a short-lived process, so its in-memory gauge cannot be
scraped after the job exits. Configure the repository variable
`PROMETHEUS_PUSHGATEWAY_URL` with the reachable Pushgateway base URL. On success,
the workflow publishes the gauge to
`/metrics/job/dr_backup_restore_validation`. Add the
`dr-rehearsal-pushgateway` scrape job from
`deploy/monitoring/prometheus/prometheus.yml` to the active Prometheus config,
alongside the backend `/metrics` scrape. The workflow fails and pages on-call if
the variable is missing or the Pushgateway rejects the update.

#### Staleness & Escalation Alerting

- **Prometheus Alert**: `DisasterRecoveryRehearsalStale` (in `deploy/monitoring/prometheus/alert-rules.yaml`) triggers if `(time() - dr_rehearsal_last_success_timestamp) > 604800` (rehearsal overdue > 7 days).
- **On-Call Paging**: On rehearsal or validation script failure, `alertingService` automatically emits a critical alert and pages the on-call engineer via PagerDuty / Slack per [INCIDENT_RESPONSE.md](./INCIDENT_RESPONSE.md).

### Manual Script Execution

Operators can also manually run the validation harness against any local or staging database:

```bash
npx ts-node scripts/validate-backup-restore.ts
```

The script verifies:

1. Database connectivity and public table completeness (`database_tables_exist`).
2. Wallet encryption key availability and length verification (`wallet_encryption_key_configured`).
3. Core user table integrity and accessibility (`data_integrity_user_table`).
4. Prisma migration status and schema drift (`prisma_migration_status`).
5. Multi-table row count integrity spot-check (`table_row_count_spot_check`).
6. Disaster recovery retention policy alignment (`dr_retention_policy_aligned`).
7. Updates the local `dr_rehearsal_last_success_timestamp` gauge on success; CI publishes it to Pushgateway and writes `reports/dr-rehearsal-report.json`.
