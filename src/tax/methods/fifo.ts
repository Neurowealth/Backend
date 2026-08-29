/**
 * FIFO: oldest lot first. Byte-identical ordering to the original
 * src/tax/fifo.ts (acquiredAt asc, id tiebreak) — this is the default
 * method and must not change existing users' realized-gain figures.
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
      const byTime = a.acquiredAt.getTime() - b.acquiredAt.getTime()
      if (byTime !== 0) return byTime
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
}

export const fifoMethod: CostBasisMethod = {
  id: 'FIFO',
  consumeLots(
    lots: OpenLot[],
    amount: Decimal,
    disposalPrice: Decimal | null
  ): ConsumptionResult {
    return consumeOrderedLots(order(lots), amount, disposalPrice)
  },
}
