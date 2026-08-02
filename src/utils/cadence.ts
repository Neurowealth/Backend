export type Cadence = 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY'

/**
 * Add a cadence interval to a date, returning the next occurrence.
 */
export function addCadence(cadence: Cadence, from: Date): Date {
  const result = new Date(from)
  switch (cadence) {
    case 'WEEKLY':
      result.setDate(result.getDate() + 7)
      break
    case 'BIWEEKLY':
      result.setDate(result.getDate() + 14)
      break
    case 'MONTHLY':
      result.setMonth(result.getMonth() + 1)
      break
  }
  return result
}
