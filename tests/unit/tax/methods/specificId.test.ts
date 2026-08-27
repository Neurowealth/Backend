// SPECIFIC_ID engine tests (#317): disposal against explicitly selected
// lots only, in the given order — validated (no double-selection, unknown
// lot ids, shortfall) before any instruction is produced.
import { Decimal } from '@prisma/client/runtime/library'
import {
  specificIdMethod,
  SpecificIdSelectionError,
} from '../../../../src/tax/methods/specificId'
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

const lots = [
  lot('a', 40, '2026-01-01', '1'),
  lot('b', 30, '2026-02-01', '2'),
  lot('c', 50, '2026-03-01', '0.5'),
]

describe('specificIdMethod', () => {
  it('consumes only the selected lots, in the given order', () => {
    const result = specificIdMethod.consumeLots(lots, d(60), d(10), {
      selectedLotIds: ['c', 'a'],
    })

    expect(result.disposals.map((x) => x.lotId)).toEqual(['c', 'a'])
    expect(result.disposals[0].amount.toString()).toBe('50')
    expect(result.disposals[1].amount.toString()).toBe('10')
  })

  it('requires selectedLotIds to be provided', () => {
    expect(() => specificIdMethod.consumeLots(lots, d(60), d(10))).toThrow(
      SpecificIdSelectionError
    )
  })

  it('rejects a duplicate lot id in the selection', () => {
    expect(() =>
      specificIdMethod.consumeLots(lots, d(60), d(10), {
        selectedLotIds: ['a', 'a'],
      })
    ).toThrow(SpecificIdSelectionError)
  })

  it('rejects an unknown lot id', () => {
    expect(() =>
      specificIdMethod.consumeLots(lots, d(60), d(10), {
        selectedLotIds: ['does-not-exist'],
      })
    ).toThrow(SpecificIdSelectionError)
  })

  it('rejects a lot id with zero remaining amount', () => {
    const exhausted = [...lots, lot('empty', 0, '2026-04-01', '1')]

    expect(() =>
      specificIdMethod.consumeLots(exhausted, d(10), d(10), {
        selectedLotIds: ['empty'],
      })
    ).toThrow(SpecificIdSelectionError)
  })

  it('throws InsufficientLotsError (all-or-nothing) when the selection cannot cover the amount', () => {
    expect(() =>
      specificIdMethod.consumeLots(lots, d(60), d(10), {
        selectedLotIds: ['a'], // only 40 available
      })
    ).toThrow(InsufficientLotsError)
  })

  it('never partially selects a lot not in selectedLotIds, even if it would cover the shortfall', () => {
    let caught: InsufficientLotsError | undefined
    try {
      specificIdMethod.consumeLots(lots, d(50), d(10), {
        selectedLotIds: ['a'], // 40 available; 'b'/'c' exist but weren't selected
      })
    } catch (err) {
      caught = err as InsufficientLotsError
    }

    expect(caught).toBeInstanceOf(InsufficientLotsError)
    expect(caught!.available.toString()).toBe('40')
  })
})
