/**
 * LIFO: most-recently-acquired lot first. Mirror image of FIFO's ordering
 * (acquiredAt desc, id desc tiebreak) on the same fixture lots.
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
      const byTime = b.acquiredAt.getTime() - a.acquiredAt.getTime()
      if (byTime !== 0) return byTime
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
    })
}

export const lifoMethod: CostBasisMethod = {
  id: 'LIFO',
  consumeLots(
    lots: OpenLot[],
    amount: Decimal,
    disposalPrice: Decimal | null
  ): ConsumptionResult {
    return consumeOrderedLots(order(lots), amount, disposalPrice)
  },
}
