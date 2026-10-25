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

## 5. Automated Backup & Restore Validation Script

Run the automated backup validation harness:

```bash
npx ts-node scripts/validate-backup-restore.ts
```

The script verifies:

1. Database connectivity and table schema completeness.
2. Wallet encryption key availability and decryption integrity.
3. Backup snapshot timestamp and WAL lag (< 15 mins).
4. System health readiness endpoint status.
