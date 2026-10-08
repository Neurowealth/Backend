import {
  supportSla,
  supportSlaHours,
  SUPPORT_TRANSITIONS,
} from '../../../src/services/support-ticket.service'

describe('support ticket SLA and transitions', () => {
  const createdAt = new Date('2026-10-01T00:00:00Z')
  const now = new Date('2026-10-01T03:00:00Z')
  it('breaches urgent tickets at two hours but not medium tickets', () => {
    expect(
      supportSla({ priority: 'URGENT', status: 'OPEN', createdAt }, now)
        .slaBreached
    ).toBe(true)
    expect(
      supportSla({ priority: 'MEDIUM', status: 'OPEN', createdAt }, now)
        .slaBreached
    ).toBe(false)
  })
  it('does not flag completed tickets', () => {
    expect(
      supportSla({ priority: 'URGENT', status: 'RESOLVED', createdAt }, now)
        .slaBreached
    ).toBe(false)
  })
  it('uses valid environment overrides and ignores malformed values', () => {
    process.env.SUPPORT_SLA_HIGH_HOURS = '4'
    expect(supportSlaHours('HIGH')).toBe(4)
    process.env.SUPPORT_SLA_HIGH_HOURS = '-1'
    expect(supportSlaHours('HIGH')).toBe(8)
    delete process.env.SUPPORT_SLA_HIGH_HOURS
  })
  it('allows resolution to reopen and prevents reopening a closed ticket', () => {
    expect(SUPPORT_TRANSITIONS.RESOLVED).toContain('IN_PROGRESS')
    expect(SUPPORT_TRANSITIONS.CLOSED).toEqual([])
  })
})
