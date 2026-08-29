// LIFO engine tests (#317). Mirror image of FIFO's ordering on the same
// fixture lots — same invariants: all-or-nothing shortfall, remainingAmount
// never negative, unpriced lots propagate null (never zero).
import { Decimal } from '@prisma/client/runtime/library'
import { lifoMethod } from '../../../../src/tax/methods/lifo'
import {
  InsufficientLotsError,
  OpenLot,
} from '../../../../src/tax/methods/types'

const d = (v: string | number) => new Decimal(v)

function lot(
  id: string,
  remaining: string | number,
  acquiredAt: string,
  price: string | number | null = 1
): OpenLot {
  return {
    id,
    remainingAmount: d(remaining),
    acquisitionPrice: price === null ? null : d(price),
    acquiredAt: new Date(acquiredAt),
  }
}

describe('lifoMethod', () => {
  it('consumes the most-recently-acquired lot first', () => {
    const result = lifoMethod.consumeLots(
      [lot('older', 40, '2026-01-01'), lot('newer', 50, '2026-02-01')],
      d(60),
      d(1)
    )

    expect(result.disposals.map((x) => x.lotId)).toEqual(['newer', 'older'])
    expect(result.disposals[0].amount.toString()).toBe('50')
    expect(result.disposals[1].amount.toString()).toBe('10')
  })

  it('breaks acquiredAt ties by id descending (mirror of FIFO ascending)', () => {
    const result = lifoMethod.consumeLots(
      [lot('a', 10, '2026-01-01'), lot('b', 10, '2026-01-01')],
      d(15),
      d(1)
    )

    expect(result.disposals.map((x) => x.lotId)).toEqual(['b', 'a'])
  })

  it('throws InsufficientLotsError before producing any instructions', () => {
    expect(() =>
      lifoMethod.consumeLots([lot('a', 40, '2026-01-01')], d(100), d(1))
    ).toThrow(InsufficientLotsError)
  })

  it('never leaves remainingAmount negative', () => {
    const result = lifoMethod.consumeLots(
      [lot('a', 25, '2026-01-01'), lot('b', 75, '2026-02-01')],
      d(100),
      d(1)
    )

    expect(result.updatedLots.every((l) => l.remainingAmount.isZero())).toBe(
      true
    )
  })
})
