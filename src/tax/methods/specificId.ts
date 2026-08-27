/**
 * SPECIFIC_ID: disposal against explicitly selected lots, in the given
 * order. Unlike FIFO/LIFO/HIFO (which derive an order from all open lots),
 * this method only ever sees the lots the caller selected — so "selection
 * cannot exceed remaining" falls out of the same all-or-nothing
 * `InsufficientLotsError` shortfall check every other method uses, just
 * scoped to a smaller lot set.
 */
import { Decimal } from '@prisma/client/runtime/library'
import {
  CostBasisMethod,
  OpenLot,
  ConsumptionResult,
  MethodOptions,
  consumeOrderedLots,
} from './types'

export class SpecificIdSelectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SpecificIdSelectionError'
  }
}

function order(
  lots: OpenLot[],
  selectedLotIds: string[] | undefined
): OpenLot[] {
  if (!selectedLotIds || selectedLotIds.length === 0) {
    throw new SpecificIdSelectionError(
      'selectedLotIds is required for the SPECIFIC_ID method'
    )
  }

  const seen = new Set<string>()
  for (const id of selectedLotIds) {
    if (seen.has(id)) {
      throw new SpecificIdSelectionError(
        `Lot ${id} was selected more than once`
      )
    }
    seen.add(id)
  }

  const byId = new Map(lots.map((lot) => [lot.id, lot]))
  return selectedLotIds.map((id) => {
    const lot = byId.get(id)
    if (!lot || !lot.remainingAmount.greaterThan(0)) {
      throw new SpecificIdSelectionError(
        `Lot ${id} is not an open lot for this user/asset`
      )
    }
    return lot
  })
}

export const specificIdMethod: CostBasisMethod = {
  id: 'SPECIFIC_ID',
  consumeLots(
    lots: OpenLot[],
    amount: Decimal,
    disposalPrice: Decimal | null,
    options?: MethodOptions
  ): ConsumptionResult {
    return consumeOrderedLots(
      order(lots, options?.selectedLotIds),
      amount,
      disposalPrice
    )
  },
}
