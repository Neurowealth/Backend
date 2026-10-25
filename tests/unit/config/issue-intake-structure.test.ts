/**
 * Structural guarantee for the issue backlog intake (#499).
 *
 * #499 asks for a standardized issue format and documented triage labels.
 * Like tests/unit/outbox/structural.test.ts, this is an acceptance
 * criterion, not a style check: the template and the label vocabulary in
 * CONTRIBUTING.md are the contract — if either disappears or drifts from
 * the real GitHub label set, new issues stop being triageable.
 */

import fs from 'fs'
import path from 'path'

const ROOT_DIR = path.join(__dirname, '../../..')
const TEMPLATE_DIR = path.join(ROOT_DIR, '.github', 'ISSUE_TEMPLATE')

/** Labels that actually exist in the repo (`gh label list`), by role. */
const TRIAGE_LABELS = {
  primaryTypes: ['bug', 'enhancement', 'documentation', 'question'],
  community: [
    'good first issue',
    'help wanted',
    'GrantFox OSS',
    'Maybe Rewarded',
    'Official Campaign',
    'Stellar Wave',
  ],
  dispositions: ['duplicate', 'invalid', 'wontfix'],
  campaigns: ['Beta-Campaign', 'Official Campaign | FWC26', 'Third Campaign'],
} as const

/** Every label any existing issue template frontmatter requests. */
const TEMPLATE_LABELS = [
  ...TRIAGE_LABELS.primaryTypes,
  ...TRIAGE_LABELS.community.filter(
    (l) => l !== 'Official Campaign' // only used on special campaign issues
  ),
]

function readTemplate(name: string): string {
  const file = path.join(TEMPLATE_DIR, name)
  expect(fs.existsSync(file)).toBe(true)
  return fs.readFileSync(file, 'utf8')
}

describe('issue intake structure (#499)', () => {
  it('every requested label in template frontmatter exists in the repo vocabulary', () => {
    for (const name of [
      'bug_report.md',
      'feature_request.md',
      'documentation.md',
      'backlog_cleanup.md',
    ]) {
      const source = readTemplate(name)
      const frontmatter = source.split('---')[1] ?? ''
      for (const label of TEMPLATE_LABELS) {
        if (frontmatter.includes(`labels: ${label}`)) {
          // The label must be one of the repo's real labels.
          const known = [
            ...TRIAGE_LABELS.primaryTypes,
            ...TRIAGE_LABELS.community,
            ...TRIAGE_LABELS.dispositions,
            ...TRIAGE_LABELS.campaigns,
          ]
          expect(known).toContain(label)
        }
      }
    }
  })

  it('backlog cleanup template declares frontmatter matching the existing style', () => {
    const source = readTemplate('backlog_cleanup.md')
    expect(source.startsWith('---')).toBe(true)
    expect(source).toMatch(/name: "\\U0001F9F9 Backlog Cleanup"/)
    expect(source).toMatch(/^title: "\[BACKLOG\] "/m)
    expect(source).toMatch(
      /^labels: help wanted, GrantFox OSS, Maybe Rewarded$/m
    )
    expect(source).toMatch(/^assignees: ''$/m)
  })

  it('backlog cleanup template supports auditable triage outcomes', () => {
    const source = readTemplate('backlog_cleanup.md')
    // Items are enumerated so a pass has a concrete, checkable scope.
    expect(source).toContain('## Items to Triage')
    // Outcomes are stated per item: close / relabel / split / promote.
    expect(source).toContain('close / relabel / split / promote')
    // Acceptance criteria keep passes honest.
    expect(source).toContain('## Acceptance Criteria')
  })

  it('CONTRIBUTING.md documents the triage label vocabulary', () => {
    const contributing = fs.readFileSync(
      path.join(ROOT_DIR, 'CONTRIBUTING.md'),
      'utf8'
    )
    expect(contributing).toContain('## Issue Triage')
    for (const label of [
      ...TRIAGE_LABELS.primaryTypes,
      ...TRIAGE_LABELS.community,
      ...TRIAGE_LABELS.dispositions,
    ]) {
      expect(contributing).toContain(`\`${label}\``)
    }
  })

  it('CONTRIBUTING.md documents the triage workflow using the template', () => {
    const contributing = fs.readFileSync(
      path.join(ROOT_DIR, 'CONTRIBUTING.md'),
      'utf8'
    )
    expect(contributing).toContain('Backlog Cleanup')
    expect(contributing).toContain('### Triage Workflow')
  })
})
