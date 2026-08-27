/**
 * HIFO: highest acquisitionPrice first (minimizes realized gain / maximizes
 * loss-harvesting). Unpriced lots (acquisitionPrice === null) sort last —
 * they cannot be "highest" — with a documented, deterministic tiebreak
 * (acquiredAt asc, then id) so two runs on the same lots always produce the
 * same disposal order.
 */
import { Decimal } from '@prisma/client/runtime/library'
import {
  CostBasisMethod,
  OpenLot,
  ConsumptionResult,
  consumeOrderedLots,
} from './types'

function order(lots: OpenLot[]): OpenLot[] {
  return lots
    .filter((lot) => lot.remainingAmount.greaterThan(0))
    .sort((a, b) => {
      if (a.acquisitionPrice === null && b.acquisitionPrice === null) {
        return tiebreak(a, b)
      }
      if (a.acquisitionPrice === null) return 1
      if (b.acquisitionPrice === null) return -1

      const byPrice = b.acquisitionPrice.comparedTo(a.acquisitionPrice)
      if (byPrice !== 0) return byPrice
      return tiebreak(a, b)
    })
}

function tiebreak(a: OpenLot, b: OpenLot): number {
  const byTime = a.acquiredAt.getTime() - b.acquiredAt.getTime()
  if (byTime !== 0) return byTime
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export const hifoMethod: CostBasisMethod = {
  id: 'HIFO',
  consumeLots(
    lots: OpenLot[],
    amount: Decimal,
    disposalPrice: Decimal | null
  ): ConsumptionResult {
    return consumeOrderedLots(order(lots), amount, disposalPrice)
  },
}
