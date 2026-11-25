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

  it.each([2026, 2028])(
    'clamps February and restores the anchor day in %i',
    (year: number) => {
      const from = new Date(`${year}-01-31T12:00:00Z`)
      const feb = addCadence('MONTHLY', from, 31)
      expect(feb.toISOString()).toBe(
        `${year}-02-${year === 2028 ? 29 : 28}T12:00:00.000Z`
      )
      expect(addCadence('MONTHLY', feb, 31).toISOString()).toBe(
        `${year}-03-31T12:00:00.000Z`
      )
    }
  )

  it('keeps the UTC hour across daylight saving transitions', () => {
    const from = new Date('2026-03-04T12:00:00Z')
    expect(addCadence('WEEKLY', from).toISOString()).toBe(
      '2026-03-11T12:00:00.000Z'
    )
    expect(addCadence('MONTHLY', from).toISOString()).toBe(
      '2026-04-04T12:00:00.000Z'
    )
  })

  it('does not mutate the original date', () => {
    const from = new Date('2026-06-01T12:00:00Z')
    const original = from.toISOString()
    addCadence('WEEKLY', from)
    expect(from.toISOString()).toBe(original)
  })
})
