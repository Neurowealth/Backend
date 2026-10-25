/**
 * Digest scheduling helpers (#365).
 *
 * All times are UTC. A subscription has a preferred `sendHourUtc` (0..23) and,
 * for WEEKLY, a `weeklyDayUtc` (0..6 = Sunday..Saturday). `nextRunAt` is derived
 * by `nextOccurrence` and persisted; the job advances it after each delivery.
 *
 * `deferForQuietHours` implements the "never send inside the quiet window"
 * preference by deferring to the next allowed hour — it NEVER drops a digest, it
 * only delays it. If the whole day is quiet, the digest is sent at
 * `quietHours.endUtc` on the next available day.
 */

export interface QuietHours {
  /** Hour of the quiet window start (0..23, UTC). */
  startUtc: number
  /** Hour of the quiet window end (0..23, UTC). */
  endUtc: number
}

export type Frequency = 'DAILY' | 'WEEKLY' | 'MONTHLY'

export function isQuietHours(value: unknown): value is QuietHours {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.startUtc === 'number' &&
    typeof v.endUtc === 'number' &&
    v.startUtc >= 0 &&
    v.startUtc <= 23 &&
    v.endUtc >= 0 &&
    v.endUtc <= 23
  )
}

function clampHour(h: number): number {
  if (!Number.isFinite(h)) return 0
  return ((Math.round(h) % 24) + 24) % 24
}

/** Date at the given UTC day-of-month/hour/minute. */
function atUtc(
  year: number,
  month0: number,
  day: number,
  hour: number,
  minute = 0
): Date {
  return new Date(Date.UTC(year, month0, day, clampHour(hour), minute))
}

/** True when the UTC hour `hour` is strictly inside the quiet window. */
function isInsideQuiet(hour: number, quiet: QuietHours | null): boolean {
  if (!quiet) return false
  if (quiet.startUtc === quiet.endUtc) return false // zero-length window = no-op
  if (quiet.startUtc < quiet.endUtc) {
    return hour >= quiet.startUtc && hour < quiet.endUtc
  }
  // Wraps midnight (e.g. 22 -> 06).
  return hour >= quiet.startUtc || hour < quiet.endUtc
}

/** Last hour of the day that is NOT inside the quiet window, or null if none. */
function lastAllowedHourOfDay(quiet: QuietHours | null): number | null {
  if (!quiet || quiet.startUtc === quiet.endUtc) return 23
  for (let h = 23; h >= 0; h--) {
    if (!isInsideQuiet(h, quiet)) return h
  }
  return null
}

/**
 * Compute the next natural send slot strictly after `after`, according to
 * `frequency` (and `weeklyDayUtc` for WEEKLY), always landing on `sendHourUtc`.
 * Month-end (> 28th) DAYS are clamped to the last day of the month.
 */
export function nextOccurrence(
  frequency: Frequency,
  sendHourUtc: number,
  weeklyDayUtc: number | null,
  after: Date
): Date {
  const hour = clampHour(sendHourUtc)
  const afterUtc = Date.UTC(
    after.getUTCFullYear(),
    after.getUTCMonth(),
    after.getUTCDate(),
    after.getUTCHours(),
    after.getUTCMinutes(),
    after.getUTCSeconds()
  )

  switch (frequency) {
    case 'DAILY': {
      const cand = atUtc(
        after.getUTCFullYear(),
        after.getUTCMonth(),
        after.getUTCDate(),
        hour
      )
      return cand.getTime() > afterUtc
        ? cand
        : new Date(cand.getTime() + 86400000)
    }
    case 'WEEKLY': {
      const day = weeklyDayUtc === null ? 1 : clampHour(weeklyDayUtc) % 7 // default Monday
      // Walk forward to the next occurrence of `day` strictly after `after`.
      for (let i = 1; i <= 8; i++) {
        const d = new Date(
          Date.UTC(
            after.getUTCFullYear(),
            after.getUTCMonth(),
            after.getUTCDate() + i
          )
        )
        if (d.getUTCDay() === day) {
          return atUtc(
            d.getUTCFullYear(),
            d.getUTCMonth(),
            d.getUTCDate(),
            hour
          )
        }
      }
      // Unreachable: 8 consecutive days always contain every weekday.
      throw new Error('Could not compute weekly digest occurrence')
    }
    case 'MONTHLY': {
      // Anchor to `after`'s day-of-month (clamped to the target month's last
      // day) at the preferred hour. A subscription created on the 31st lands on
      // the last day of every shorter month — never skips a month.
      let year = after.getUTCFullYear()
      let month0 = after.getUTCMonth()
      const day = after.getUTCDate()
      let cand = atUtc(year, month0, day, hour)
      if (cand.getTime() <= afterUtc) {
        // Next month.
        month0 += 1
        if (month0 === 12) {
          month0 = 0
          year += 1
        }
      }
      const lastDay = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate()
      return atUtc(year, month0, Math.min(day, lastDay), hour)
    }
  }
}

/**
 * Given a candidate send slot (a Date carrying the preferred hour), defer it out
 * of the quiet window. Returns a slot on the SAME day if an allowed hour exists,
 * else a slot at `quietHours.endUtc` on the next day the window opens.
 */
export function deferForQuietHours(
  candidate: Date,
  quiet: QuietHours | null
): Date {
  if (!quiet || quiet.startUtc === quiet.endUtc) return candidate
  const hour = candidate.getUTCHours()
  if (!isInsideQuiet(hour, quiet)) return candidate

  const allowed = lastAllowedHourOfDay(quiet)
  if (allowed !== null && allowed > hour) {
    return atUtc(
      candidate.getUTCFullYear(),
      candidate.getUTCMonth(),
      candidate.getUTCDate(),
      allowed
    )
  }
  // No allowed hour later today: defer to `quiet.endUtc` on the next day.
  const endHour = clampHour(quiet.endUtc)
  const next = new Date(candidate.getTime() + 86400000)
  return atUtc(
    next.getUTCFullYear(),
    next.getUTCMonth(),
    next.getUTCDate(),
    endHour
  )
}
