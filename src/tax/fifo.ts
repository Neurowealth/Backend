/**
 * Backward-compatible FIFO entry point (#284, extended by #317).
 *
 * The actual method implementations now live in src/tax/methods/ (a
 * method-parameterized engine — LIFO/HIFO/SPECIFIC_ID added alongside
 * FIFO). This module re-exports the original names byte-identically so
 * every existing caller/import of `consumeLotsFifo` keeps working
 * unchanged; src/tax/service.ts and scripts/backfill-cost-basis-lots.ts
 * behave exactly as before when no method is specified (FIFO is the
 * default `AccountingMethod`).
 */
import { Decimal } from '@prisma/client/runtime/library'
import { fifoMethod } from './methods/fifo'
import {
  OpenLot,
  DisposalInstruction as MethodDisposalInstruction,
  ConsumptionResult,
  InsufficientLotsError,
} from './methods/types'

export type { OpenLot }
export type DisposalInstruction = MethodDisposalInstruction
export type FifoResult = ConsumptionResult
export { InsufficientLotsError }

export function consumeLotsFifo(
  lots: OpenLot[],
  amount: Decimal,
  disposalPrice: Decimal | null
): FifoResult {
  return fifoMethod.consumeLots(lots, amount, disposalPrice)
}
