/**
 * Unit tests for Disaster Recovery Rehearsal and Backup Validation (#511, #681)
 */

import fs from 'fs'
import path from 'path'
import { validateBackupAndRestore } from '../../../scripts/validate-backup-restore'
import {
  drRehearsalLastSuccessTimestamp,
  publishDrRehearsalSuccess,
  recordDrRehearsalSuccess,
} from '../../../src/utils/metrics'

const ROOT = path.resolve(__dirname, '../../..')

describe('Disaster Recovery Rehearsal & Backup Validation (#511, #681)', () => {
  const drDocPath = path.join(ROOT, 'docs', 'DISASTER_RECOVERY_REHEARSAL.md')
  const workflowPath = path.join(
    ROOT,
    '.github',
    'workflows',
    'dr-backup-restore-validation.yml'
  )
  const alertRulesPath = path.join(
    ROOT,
    'deploy',
    'monitoring',
    'prometheus',
    'alert-rules.yaml'
  )

  it('documented DR rehearsal checklist file exists', () => {
    expect(fs.existsSync(drDocPath)).toBe(true)
  })

  it('documents backup scope and retention policies', () => {
    const doc = fs.readFileSync(drDocPath, 'utf8')
    expect(doc).toContain('Backup Scope & Retention Policy')
    expect(doc).toContain('PostgreSQL')
    expect(doc).toContain('Retention Windows')
    expect(doc).toMatch(/RPO Target/i)
    expect(doc).toMatch(/RTO Target/i)
  })

  it('documents restore procedure and key decision points', () => {
    const doc = fs.readFileSync(drDocPath, 'utf8')
    expect(doc).toContain('Key Decision Matrix')
    expect(doc).toContain('Owner Assignments')
    expect(doc).toContain('Incident Commander')
    expect(doc).toContain('Database Administrator')
    expect(doc).toContain('Disaster Recovery Rehearsal Checklist')
  })

  it('documents continuous CI automation and dr_rehearsal_last_success_timestamp metric (#681)', () => {
    const doc = fs.readFileSync(drDocPath, 'utf8')
    expect(doc).toContain('dr-backup-restore-validation.yml')
    expect(doc).toContain('dr_rehearsal_last_success_timestamp')
    expect(doc).toContain('DisasterRecoveryRehearsalStale')
    expect(doc).toContain('INCIDENT_RESPONSE.md')
  })

  it('scheduled CI workflow exists and defines restore validation steps (#681)', () => {
    expect(fs.existsSync(workflowPath)).toBe(true)
    const workflow = fs.readFileSync(workflowPath, 'utf8')
    expect(workflow).toContain("cron: '0 2 * * *'")
    expect(workflow).toContain('workflow_dispatch')
    expect(workflow).toContain('prisma migrate status')
    expect(workflow).toContain('scripts/validate-backup-restore.ts')
    expect(workflow).toContain('dr-rehearsal-report')
    expect(workflow).toContain('upload-artifact')
  })

  it('exports dr_rehearsal_last_success_timestamp Prometheus gauge (#681)', async () => {
    expect(drRehearsalLastSuccessTimestamp).toBeDefined()
    expect(drRehearsalLastSuccessTimestamp.name).toBe(
      'dr_rehearsal_last_success_timestamp'
    )

    const sampleTimestamp = 1761000000
    recordDrRehearsalSuccess(sampleTimestamp)
    const metricData = await drRehearsalLastSuccessTimestamp.get()
    expect(metricData.values[0]?.value).toBe(sampleTimestamp)
  })

  it('publishes successful CI rehearsal timestamps to Pushgateway', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 202,
    } as Response)

    await publishDrRehearsalSuccess('http://pushgateway:9091/', 1761000000)

    expect(fetchMock).toHaveBeenCalledWith(
      'http://pushgateway:9091/metrics/job/dr_backup_restore_validation',
      expect.objectContaining({
        method: 'PUT',
        body: 'dr_rehearsal_last_success_timestamp 1761000000\n',
      })
    )
    fetchMock.mockRestore()
  })

  it('prometheus alert rules configure DisasterRecoveryRehearsalStale (#681)', () => {
    expect(fs.existsSync(alertRulesPath)).toBe(true)
    const rules = fs.readFileSync(alertRulesPath, 'utf8')
    expect(rules).toContain('alert: DisasterRecoveryRehearsalStale')
    expect(rules).toContain('dr_rehearsal_last_success_timestamp')
    expect(rules).toContain('604800')
  })

  it('validation script runs backup and restore checks including migrations and spot-checks (#681)', async () => {
    const result = await validateBackupAndRestore()
    expect(result).toHaveProperty('success')
    expect(result).toHaveProperty('checks')
    expect(result).toHaveProperty('durationMs')
    expect(typeof result.durationMs).toBe('number')
    expect(Array.isArray(result.checks)).toBe(true)
    expect(result.checks.length).toBeGreaterThanOrEqual(6)

    const checkNames = result.checks.map((c) => c.name)
    expect(checkNames).toContain('database_tables_exist')
    expect(checkNames).toContain('wallet_encryption_key_configured')
    expect(checkNames).toContain('data_integrity_user_table')
    expect(checkNames).toContain('prisma_migration_status')
    expect(checkNames).toContain('table_row_count_spot_check')
    expect(checkNames).toContain('dr_retention_policy_aligned')
  })

  it('is indexed in DOCUMENTATION_INDEX.md', () => {
    const docIndex = fs.readFileSync(
      path.join(ROOT, 'docs', 'DOCUMENTATION_INDEX.md'),
      'utf8'
    )
    expect(docIndex).toContain('DISASTER_RECOVERY_REHEARSAL.md')
  })
})
