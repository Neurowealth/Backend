/**
 * Unit tests for Operational Job Dashboard & Telemetry (#509)
 */

import fs from 'fs'
import path from 'path'
import {
  getJobDashboardSnapshot,
  recordJobCompletion,
  recordJobRetry,
} from '../../../src/utils/job-metrics'

const ROOT = path.resolve(__dirname, '../../..')

describe('Operational Job Dashboard & Telemetry (#509)', () => {
  it('records job retries and completion status in telemetry', async () => {
    const jobName = 'test_retention_sweep'

    recordJobRetry(jobName)
    recordJobCompletion(jobName, 'success')

    const snapshot = await getJobDashboardSnapshot()

    expect(snapshot).toHaveProperty('timestamp')
    expect(snapshot).toHaveProperty('jobs')
    expect(snapshot.jobs[jobName]).toBeDefined()
    expect(snapshot.jobs[jobName].retryTotal).toBeGreaterThanOrEqual(1)
    expect(snapshot.jobs[jobName].lastStatus).toBe('success')
  })

  it('documents operator triage runbook for repeated failed jobs and DLQ buildup', () => {
    const triageDocPath = path.join(ROOT, 'docs', 'JOB_TRIAGE_RUNBOOK.md')
    expect(fs.existsSync(triageDocPath)).toBe(true)

    const doc = fs.readFileSync(triageDocPath, 'utf8')
    expect(doc).toContain('Background Job & DLQ Triage Runbook')
    expect(doc).toContain('/api/admin/jobs/dashboard')
    expect(doc).toContain('Diagnostic Matrix')
    expect(doc).toContain('DLQ Replay Procedure')
  })

  it('indexes JOB_TRIAGE_RUNBOOK.md in DOCUMENTATION_INDEX.md', () => {
    const indexContent = fs.readFileSync(
      path.join(ROOT, 'docs', 'DOCUMENTATION_INDEX.md'),
      'utf8'
    )
    expect(indexContent).toContain('JOB_TRIAGE_RUNBOOK.md')
  })
})
