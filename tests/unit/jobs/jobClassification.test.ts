/**
 * #636 — every scheduled job must appear in the concurrency classification
 * table. An unclassified job fails review: adding `jobName: 'new_thing'` to
 * src/jobs/ without a row here breaks this suite.
 */
import * as fs from 'fs'
import * as path from 'path'
import { JOB_CLASSIFICATION } from '../../../src/jobs/jobClassification'

const JOBS_DIR = path.resolve(__dirname, '../../../src/jobs')

function collectScheduledJobNames(): string[] {
  const names = new Set<string>()
  for (const file of fs.readdirSync(JOBS_DIR)) {
    if (!file.endsWith('.ts')) continue
    const source = fs.readFileSync(path.join(JOBS_DIR, file), 'utf8')
    // jobName: 'literal'
    for (const match of source.matchAll(/jobName:\s*'([^']+)'/g)) {
      names.add(match[1])
    }
    // jobName: CONSTANT   → resolve `export const CONSTANT = 'value'`
    for (const match of source.matchAll(/jobName:\s*([A-Z][A-Z0-9_]*)\b/g)) {
      const constName = match[1]
      const def = new RegExp(
        `(?:export\\s+)?const\\s+${constName}\\s*=\\s*'([^']+)'`
      ).exec(source)
      if (def) names.add(def[1])
    }
  }
  return [...names].sort()
}

describe('job classification (#636)', () => {
  it('classifies every job scheduled through scheduleResilientJob', () => {
    const scheduled = collectScheduledJobNames()
    expect(scheduled.length).toBeGreaterThan(15)

    const unclassified = scheduled.filter((n) => !(n in JOB_CLASSIFICATION))
    expect(unclassified).toEqual([])
  })

  it('has no classification rows for jobs that are not scheduled', () => {
    const scheduled = new Set(collectScheduledJobNames())
    const orphans = Object.keys(JOB_CLASSIFICATION).filter(
      (n) => !scheduled.has(n)
    )
    expect(orphans).toEqual([])
  })

  it('labels every entry with a known concurrency class', () => {
    const allowed = new Set([
      'locked',
      'idempotent-by-design',
      'safe-to-run-concurrently',
    ])
    for (const [name, cls] of Object.entries(JOB_CLASSIFICATION)) {
      expect({ name, cls }).toEqual({ name, cls: expect.any(String) })
      expect(allowed.has(cls)).toBe(true)
    }
  })
})
