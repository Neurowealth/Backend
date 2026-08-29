// HIFO engine tests (#317): highest acquisitionPrice first, unpriced lots
// sort last (they can't be "highest"), deterministic tiebreak.
import { Decimal } from '@prisma/client/runtime/library'
import { hifoMethod } from '../../../../src/tax/methods/hifo'
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

describe('hifoMethod', () => {
  it('consumes the highest-acquisitionPrice lot first', () => {
    const result = hifoMethod.consumeLots(
      [
        lot('low', 40, '2026-01-01', '1'),
        lot('high', 30, '2026-02-01', '5'),
        lot('mid', 50, '2026-03-01', '2'),
      ],
      d(60),
      d(10)
    )

    expect(result.disposals.map((x) => x.lotId)).toEqual(['high', 'mid'])
    expect(result.disposals[0].amount.toString()).toBe('30')
    expect(result.disposals[1].amount.toString()).toBe('30')
  })

  it('sorts unpriced lots last regardless of acquiredAt', () => {
    const result = hifoMethod.consumeLots(
      [
        lot('unpriced', 100, '2026-01-01', null),
        lot('priced', 50, '2026-03-01', '3'),
      ],
      d(60),
      d(10)
    )

    expect(result.disposals.map((x) => x.lotId)).toEqual(['priced', 'unpriced'])
  })

  it('breaks a price tie by acquiredAt asc, then id (deterministic)', () => {
    const result = hifoMethod.consumeLots(
      [
        lot('b', 10, '2026-02-01', '2'),
        lot('a', 10, '2026-01-01', '2'),
        lot('c', 10, '2026-01-01', '2'),
      ],
      d(30),
      d(10)
    )

    // Same price everywhere -> acquiredAt asc first, id asc tiebreak within
    // the same acquiredAt.
    expect(result.disposals.map((x) => x.lotId)).toEqual(['a', 'c', 'b'])
  })

  it('breaks a tie between two unpriced lots the same way (acquiredAt asc, id)', () => {
    const result = hifoMethod.consumeLots(
      [lot('z', 10, '2026-01-01', null), lot('y', 10, '2026-01-01', null)],
      d(15),
      d(10)
    )

    expect(result.disposals.map((x) => x.lotId)).toEqual(['y', 'z'])
  })

  it('is deterministic across repeated runs on the same input', () => {
    const lots = [
      lot('b', 10, '2026-02-01', '3'),
      lot('a', 10, '2026-01-01', '5'),
      lot('c', 10, '2026-03-01', '5'),
    ]

    const first = hifoMethod.consumeLots(lots, d(20), d(10))
    const second = hifoMethod.consumeLots(lots, d(20), d(10))

    expect(second.disposals.map((x) => x.lotId)).toEqual(
      first.disposals.map((x) => x.lotId)
    )
  })

  it('throws InsufficientLotsError before producing any instructions', () => {
    expect(() =>
      hifoMethod.consumeLots([lot('a', 40, '2026-01-01', '1')], d(100), d(1))
    ).toThrow(InsufficientLotsError)
  })
})
