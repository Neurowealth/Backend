/**
 * Pure FIFO lot-consumption engine for tax cost-basis tracking (#284).
 *
 * No database access — callers load open lots, run this, then persist the
 * returned instructions transactionally (see src/tax/service.ts). Keeping the
 * accounting method here (not in the schema) means LIFO/HIFO could be added
 * later as sibling functions without a schema change.
 */
import { Decimal } from '@prisma/client/runtime/library'

export interface OpenLot {
  id: string
  remainingAmount: Decimal
  acquisitionPrice: Decimal | null
  acquiredAt: Date
}

export interface DisposalInstruction {
  lotId: string
  amount: Decimal
  disposalPrice: Decimal | null
  // Null when the lot's acquisition price is unknown — never zero, so
  // unpriced disposals are visibly excluded from report totals.
  costBasis: Decimal | null
  proceeds: Decimal | null
  realizedGain: Decimal | null
}

export interface FifoResult {
  disposals: DisposalInstruction[]
  updatedLots: { id: string; remainingAmount: Decimal }[]
}

export class InsufficientLotsError extends Error {
  readonly requested: Decimal
  readonly available: Decimal
  readonly shortfall: Decimal

  constructor(requested: Decimal, available: Decimal) {
    super(
      `Insufficient lot balance: requested ${requested.toString()}, available ${available.toString()}`
    )
    this.name = 'InsufficientLotsError'
    this.requested = requested
    this.available = available
    this.shortfall = requested.minus(available)
  }
}

/**
 * Consume `amount` from `lots` in FIFO order (acquiredAt asc, id as a stable
 * tiebreak). All-or-nothing: throws InsufficientLotsError before producing any
 * instructions if the open lots cannot cover the full amount — partial
 * disposal rows written under an error path would poison later repair.
 */
export function consumeLotsFifo(
  lots: OpenLot[],
  amount: Decimal,
  disposalPrice: Decimal | null
): FifoResult {
  if (amount.isZero()) {
    return { disposals: [], updatedLots: [] }
  }

  const openLots = lots
    .filter((lot) => lot.remainingAmount.greaterThan(0))
    .sort((a, b) => {
      const byTime = a.acquiredAt.getTime() - b.acquiredAt.getTime()
      if (byTime !== 0) return byTime
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })

  const available = openLots.reduce(
    (sum, lot) => sum.plus(lot.remainingAmount),
    new Decimal(0)
  )
  if (available.lessThan(amount)) {
    throw new InsufficientLotsError(amount, available)
  }

  const disposals: DisposalInstruction[] = []
  const updatedLots: FifoResult['updatedLots'] = []
  let remaining = amount

  for (const lot of openLots) {
    if (remaining.isZero()) break

    const consumed = Decimal.min(lot.remainingAmount, remaining)
    remaining = remaining.minus(consumed)
    updatedLots.push({
      id: lot.id,
      remainingAmount: lot.remainingAmount.minus(consumed),
    })

    const costBasis =
      lot.acquisitionPrice !== null
        ? consumed.times(lot.acquisitionPrice)
        : null
    const proceeds =
      disposalPrice !== null ? consumed.times(disposalPrice) : null
    const realizedGain =
      costBasis !== null && proceeds !== null ? proceeds.minus(costBasis) : null

    disposals.push({
      lotId: lot.id,
      amount: consumed,
      disposalPrice,
      costBasis,
      proceeds,
      realizedGain,
    })
  }

  return { disposals, updatedLots }
}
