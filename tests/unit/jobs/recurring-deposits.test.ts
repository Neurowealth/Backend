jest.mock('../../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  logBackgroundJob: jest.fn(),
}))

import { addCadence } from '../../../src/utils/cadence'

declare const describe: any
declare const it: any
declare const expect: any

describe('recurringDeposits — addCadence', () => {
  it('WEEKLY adds 7 days', () => {
    const from = new Date('2026-01-01T00:00:00Z')
    const result = addCadence('WEEKLY', from)
    expect(result.toISOString()).toBe('2026-01-08T00:00:00.000Z')
  })

  it('BIWEEKLY adds 14 days', () => {
    const from = new Date('2026-01-01T00:00:00Z')
    const result = addCadence('BIWEEKLY', from)
    expect(result.toISOString()).toBe('2026-01-15T00:00:00.000Z')
  })

  it('MONTHLY adds 1 calendar month', () => {
    const from = new Date('2026-01-15T00:00:00Z')
    const result = addCadence('MONTHLY', from)
    expect(result.toISOString()).toBe('2026-02-15T00:00:00.000Z')
  })

  it('MONTHLY handles end-of-month overflow (Jan 31 → Mar 3, since Feb has no day 31)', () => {
    const from = new Date('2026-01-31T00:00:00Z')
    const result = addCadence('MONTHLY', from)
    // setMonth(1) on day 31 overflows: Feb 31 → Mar 3
    expect(result.getMonth()).toBe(2) // March
    expect(result.getDate()).toBe(3)
  })

  it('does not mutate the original date', () => {
    const from = new Date('2026-06-01T12:00:00Z')
    const original = from.toISOString()
    addCadence('WEEKLY', from)
    expect(from.toISOString()).toBe(original)
  })
})
