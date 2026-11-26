import {
  nextOccurrence,
  deferForQuietHours,
  isQuietHours,
} from '../../../src/notifications/schedule'

jest.mock('../../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}))

const at = (y: number, m: number, d: number, h: number, mi = 0) =>
  new Date(Date.UTC(y, m, d, h, mi))

describe('nextOccurrence', () => {
  it('advances DAILY at the preferred send hour', () => {
    const after = at(2026, 0, 15, 8, 0) // 08:00
    expect(nextOccurrence('DAILY', 9, null, after)).toEqual(
      at(2026, 0, 15, 9, 0)
    )
  })

  it('walks to the next day when today is past the send hour', () => {
    const after = at(2026, 0, 15, 10, 0) // 10:00 > 9:00
    expect(nextOccurrence('DAILY', 9, null, after)).toEqual(
      at(2026, 0, 16, 9, 0)
    )
  })

  it('finds the next WEEKLY occurrence on the configured weekday', () => {
    // Jan 15 2026 is a Thursday (UTC). weeklyDayUtc=1 => Monday.
    const after = at(2026, 0, 15, 8, 0)
    const next = nextOccurrence('WEEKLY', 9, 1, after)
    expect(next.getUTCDay()).toBe(1)
    expect(next.getUTCFullYear()).toBe(2026)
    expect(next.getUTCMonth()).toBe(0)
  })

  it('clamps MONTHLY day-of-month to the last day of a short month', () => {
    // Jan 31 -> next month Feb has 28 days -> Feb 28 at the preferred hour.
    const after = at(2026, 0, 31, 9, 0)
    const next = nextOccurrence('MONTHLY', 9, null, after)
    expect(next.getUTCMonth()).toBe(1)
    expect(next.getUTCDate()).toBe(28) // Feb 2026 (non-leap) has 28 days
    expect(next.getUTCHours()).toBe(9)
  })
})

describe('deferForQuietHours', () => {
  it('returns the candidate unchanged when outside the quiet window', () => {
    const candidate = at(2026, 0, 15, 9, 0)
    const q = { startUtc: 22, endUtc: 7 }
    expect(deferForQuietHours(candidate, q)).toEqual(candidate)
  })

  it('defers within the same day when a later allowed hour exists', () => {
    // quiet 20->23; candidate 21:00 -> defer to 23:00? lastAllowed before 23 is 19.
    const q = { startUtc: 20, endUtc: 23 }
    const candidate = at(2026, 0, 15, 21, 0)
    // Only hours < 20 or >= 23 are allowed today; the only later allowed hour is 23:00.
    expect(deferForQuietHours(candidate, q).getUTCHours()).toBe(23)
  })

  it('defers to quietHours.endUtc on the next day when the whole remainder is quiet', () => {
    const q = { startUtc: 20, endUtc: 23 }
    const candidate = at(2026, 0, 15, 23, 30)
    // 23:30 is past the 23:00 end -> defer to 23:00 the next day? end==23 -> not quiet at 23.
    // isInsideQuiet(23) for 20->23 is false (end exclusive), so unchanged is not the case here.
    // Use a window that covers late hours: 22->06.
    const q2 = { startUtc: 22, endUtc: 6 }
    const c2 = at(2026, 0, 15, 23, 0)
    const next = deferForQuietHours(c2, q2)
    expect(next.getUTCDate()).toBe(16)
    expect(next.getUTCHours()).toBe(6)
  })
})

describe('isQuietHours', () => {
  it('validates shape', () => {
    expect(isQuietHours({ startUtc: 22, endUtc: 6 })).toBe(true)
    expect(isQuietHours(null)).toBe(false)
    expect(isQuietHours({ startUtc: 99, endUtc: 6 })).toBe(false)
  })
})
