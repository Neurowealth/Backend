/**
 * Unit tests for Disaster Recovery Rehearsal and Backup Validation (#511)
 */

import fs from 'fs'
import path from 'path'
import { validateBackupAndRestore } from '../../../scripts/validate-backup-restore'

const ROOT = path.resolve(__dirname, '../../..')

describe('Disaster Recovery Rehearsal & Backup Validation (#511)', () => {
  const drDocPath = path.join(ROOT, 'docs', 'DISASTER_RECOVERY_REHEARSAL.md')

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

  it('validation script runs backup and restore checks', async () => {
    const result = await validateBackupAndRestore()
    expect(result).toHaveProperty('success')
    expect(result).toHaveProperty('checks')
    expect(Array.isArray(result.checks)).toBe(true)
    expect(result.checks.length).toBeGreaterThan(0)
  })

  it('is indexed in DOCUMENTATION_INDEX.md', () => {
    const docIndex = fs.readFileSync(
      path.join(ROOT, 'docs', 'DOCUMENTATION_INDEX.md'),
      'utf8'
    )
    expect(docIndex).toContain('DISASTER_RECOVERY_REHEARSAL.md')
  })
})
