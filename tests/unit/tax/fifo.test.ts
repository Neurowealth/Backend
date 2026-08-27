// Pure FIFO engine tests (#284). Pin the money invariants: strict FIFO order
// with a stable id tiebreak, all-or-nothing on shortfall (throws BEFORE any
// instruction is produced), remainingAmount never negative, and unpriced lots
// propagate null (never zero) into costBasis/realizedGain.
import { Decimal } from '@prisma/client/runtime/library'
import {
  consumeLotsFifo,
  InsufficientLotsError,
  OpenLot,
} from '../../../src/tax/fifo'

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

describe('consumeLotsFifo', () => {
  it('consumes a single lot exactly (lot hits zero)', () => {
    const result = consumeLotsFifo([lot('a', 100, '2026-01-01')], d(100), d(1))

    expect(result.disposals).toHaveLength(1)
    expect(result.disposals[0].amount.toString()).toBe('100')
    expect(result.updatedLots).toEqual([{ id: 'a', remainingAmount: d(0) }])
  })

  it('partially consumes a single lot', () => {
    const result = consumeLotsFifo([lot('a', 100, '2026-01-01')], d(30), d(1))

    expect(result.disposals[0].amount.toString()).toBe('30')
    expect(result.updatedLots[0].remainingAmount.toString()).toBe('70')
  })

  it('consumes multiple lots oldest-first regardless of input order', () => {
    const result = consumeLotsFifo(
      [lot('newer', 50, '2026-02-01'), lot('older', 40, '2026-01-01')],
      d(60),
      d(1)
    )

    expect(result.disposals.map((x) => x.lotId)).toEqual(['older', 'newer'])
    expect(result.disposals[0].amount.toString()).toBe('40')
    expect(result.disposals[1].amount.toString()).toBe('20')
  })

  it('breaks acquiredAt ties by id', () => {
    const result = consumeLotsFifo(
      [lot('b', 10, '2026-01-01'), lot('a', 10, '2026-01-01')],
      d(15),
      d(1)
    )

    expect(result.disposals.map((x) => x.lotId)).toEqual(['a', 'b'])
  })

  it('exact multi-lot boundary: both lots hit zero', () => {
    const result = consumeLotsFifo(
      [lot('a', 25, '2026-01-01'), lot('b', 75, '2026-02-01')],
      d(100),
      d(1)
    )

    expect(result.updatedLots.every((l) => l.remainingAmount.isZero())).toBe(
      true
    )
  })

  it('throws InsufficientLotsError with fields and zero instructions', () => {
    let caught: InsufficientLotsError | undefined
    try {
      consumeLotsFifo([lot('a', 40, '2026-01-01')], d(100), d(1))
    } catch (err) {
      caught = err as InsufficientLotsError
    }

    expect(caught).toBeInstanceOf(InsufficientLotsError)
    expect(caught!.requested.toString()).toBe('100')
    expect(caught!.available.toString()).toBe('40')
    expect(caught!.shortfall.toString()).toBe('60')
  })

  it('zero amount returns an empty result', () => {
    const result = consumeLotsFifo([lot('a', 100, '2026-01-01')], d(0), d(1))

    expect(result.disposals).toEqual([])
    expect(result.updatedLots).toEqual([])
  })

  it('unpriced lot yields null costBasis/realizedGain but priced proceeds', () => {
    const result = consumeLotsFifo(
      [lot('a', 50, '2026-01-01', null)],
      d(50),
      d(1)
    )

    expect(result.disposals[0].costBasis).toBeNull()
    expect(result.disposals[0].realizedGain).toBeNull()
    expect(result.disposals[0].proceeds!.toString()).toBe('50')
  })

  it('null disposalPrice yields null proceeds/realizedGain but priced costBasis', () => {
    const result = consumeLotsFifo([lot('a', 50, '2026-01-01', 2)], d(50), null)

    expect(result.disposals[0].proceeds).toBeNull()
    expect(result.disposals[0].realizedGain).toBeNull()
    expect(result.disposals[0].costBasis!.toString()).toBe('100')
  })

  it('skips zero-remaining lots', () => {
    const result = consumeLotsFifo(
      [lot('empty', 0, '2026-01-01'), lot('open', 30, '2026-02-01')],
      d(30),
      d(1)
    )

    expect(result.disposals.map((x) => x.lotId)).toEqual(['open'])
  })

  it('computes realizedGain = proceeds - costBasis', () => {
    const result = consumeLotsFifo(
      [lot('a', 10, '2026-01-01', '0.5')],
      d(10),
      d(2)
    )

    expect(result.disposals[0].costBasis!.toString()).toBe('5')
    expect(result.disposals[0].proceeds!.toString()).toBe('20')
    expect(result.disposals[0].realizedGain!.toString()).toBe('15')
  })
})
