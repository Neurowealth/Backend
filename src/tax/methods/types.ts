/**
 * Accounting-method abstraction (#317).
 *
 * No database access — same contract as the original src/tax/fifo.ts:
 * callers load open lots, run one of these, then persist the returned
 * instructions transactionally (see src/tax/service.ts). Every method must
 * uphold the same invariants: remainingAmount never negative, consumption
 * is all-or-nothing (InsufficientLotsError before any instructions are
 * produced), and — because these are pure functions over the caller-supplied
 * `lots` array — replaying the same inputs always produces the same
 * disposals (the actual idempotency-under-replay guarantee lives in
 * src/tax/service.ts's exists-check, unaffected by which method ran).
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

export interface ConsumptionResult {
  disposals: DisposalInstruction[]
  updatedLots: { id: string; remainingAmount: Decimal }[]
}

export interface MethodOptions {
  // SPECIFIC_ID only: the lots to consume from, in the given order. Ignored
  // by every other method.
  selectedLotIds?: string[]
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

export interface CostBasisMethod {
  readonly id: 'FIFO' | 'LIFO' | 'HIFO' | 'SPECIFIC_ID'
  consumeLots(
    lots: OpenLot[],
    amount: Decimal,
    disposalPrice: Decimal | null,
    options?: MethodOptions
  ): ConsumptionResult
}

/**
 * Shared consumption loop: given `lots` already in the method's intended
 * order, walk them front-to-back consuming `amount`. Every method (FIFO,
 * LIFO, HIFO, SPECIFIC_ID) sorts/selects differently but reduces to this
 * same walk, so the money-math (costBasis/proceeds/realizedGain, the
 * all-or-nothing shortfall check) lives in exactly one place.
 */
export function consumeOrderedLots(
  orderedOpenLots: OpenLot[],
  amount: Decimal,
  disposalPrice: Decimal | null
): ConsumptionResult {
  if (amount.isZero()) {
    return { disposals: [], updatedLots: [] }
  }

  const available = orderedOpenLots.reduce(
    (sum, lot) => sum.plus(lot.remainingAmount),
    new Decimal(0)
  )
  if (available.lessThan(amount)) {
    throw new InsufficientLotsError(amount, available)
  }

  const disposals: DisposalInstruction[] = []
  const updatedLots: ConsumptionResult['updatedLots'] = []
  let remaining = amount

  for (const lot of orderedOpenLots) {
    if (remaining.isZero()) break
    if (lot.remainingAmount.isZero()) continue

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
