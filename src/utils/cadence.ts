export type Cadence = 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY'

/** Advance a scheduled UTC slot, retaining the original monthly day. */
export function addCadence(
  cadence: Cadence,
  from: Date,
  anchorDay = from.getUTCDate()
): Date {
  const result = new Date(from)
  switch (cadence) {
    case 'WEEKLY':
      result.setUTCDate(result.getUTCDate() + 7)
      break
    case 'BIWEEKLY':
      result.setUTCDate(result.getUTCDate() + 14)
      break
    case 'MONTHLY': {
      result.setUTCDate(1)
      result.setUTCMonth(result.getUTCMonth() + 1)
      const end = new Date(result)
      end.setUTCMonth(end.getUTCMonth() + 1, 0)
      result.setUTCDate(Math.min(anchorDay, end.getUTCDate()))
      break
    }
  }
  return result
}

/** Existing plans may predate the persisted anchor day. */
export function cadenceAnchorDay(plan: {
  cadenceAnchorDay?: number | null
  createdAt?: Date
  nextRunAt: Date
}): number {
  return (
    plan.cadenceAnchorDay ??
    plan.createdAt?.getUTCDate() ??
    plan.nextRunAt.getUTCDate()
  )
}
