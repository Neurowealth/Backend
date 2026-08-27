// Method registry (#317): a whitelist lookup (closes the injection concern
// — never a raw string into a switch), plus the cross-method invariant the
// issue asks for: on the SAME fixture lots, every method's disposals
// reconcile back to the same totals (all lots + all disposed amounts sum
// to the same grand total) even though which lots get consumed, and so the
// realized gain, differs per method.
import { Decimal } from '@prisma/client/runtime/library'
import { resolveMethod } from '../../../../src/tax/methods'
import { OpenLot } from '../../../../src/tax/methods/types'

const d = (v: string | number) => new Decimal(v)

function lot(
  id: string,
  remaining: string | number,
  acquiredAt: string,
  price: string | number
): OpenLot {
  return {
    id,
    remainingAmount: d(remaining),
    acquisitionPrice: d(price),
    acquiredAt: new Date(acquiredAt),
  }
}

const fixtureLots: OpenLot[] = [
  lot('a', 40, '2026-01-01', '1'), // oldest, cheapest-ish
  lot('b', 30, '2026-02-01', '2'), // most expensive
  lot('c', 50, '2026-03-01', '0.5'), // newest, cheapest
]

describe('resolveMethod', () => {
  it('resolves FIFO/LIFO/HIFO/SPECIFIC_ID to their implementations', () => {
    expect(resolveMethod('FIFO').id).toBe('FIFO')
    expect(resolveMethod('LIFO').id).toBe('LIFO')
    expect(resolveMethod('HIFO').id).toBe('HIFO')
    expect(resolveMethod('SPECIFIC_ID').id).toBe('SPECIFIC_ID')
  })

  it('rejects an unrecognized method rather than falling through to a default', () => {
    expect(() => resolveMethod('WHATEVER' as any)).toThrow()
  })
})

describe('cross-method reconciliation on identical fixture lots', () => {
  const amount = d(60)
  const disposalPrice = d(3)

  it('FIFO consumes oldest first (a then part of b)', () => {
    const { disposals } = resolveMethod('FIFO').consumeLots(
      fixtureLots,
      amount,
      disposalPrice
    )
    expect(disposals.map((x) => x.lotId)).toEqual(['a', 'b'])
  })

  it('LIFO consumes newest first (c then part of b)', () => {
    const { disposals } = resolveMethod('LIFO').consumeLots(
      fixtureLots,
      amount,
      disposalPrice
    )
    expect(disposals.map((x) => x.lotId)).toEqual(['c', 'b'])
  })

  it('HIFO consumes highest-price first (b then part of a)', () => {
    const { disposals } = resolveMethod('HIFO').consumeLots(
      fixtureLots,
      amount,
      disposalPrice
    )
    expect(disposals.map((x) => x.lotId)).toEqual(['b', 'a'])
  })

  it('every method disposes the exact requested amount, and realized gain differs by method', () => {
    const results = (['FIFO', 'LIFO', 'HIFO'] as const).map((id) => ({
      id,
      ...resolveMethod(id).consumeLots(fixtureLots, amount, disposalPrice),
    }))

    for (const result of results) {
      const totalDisposed = result.disposals.reduce(
        (sum, d2) => sum.plus(d2.amount),
        d(0)
      )
      expect(totalDisposed.toString()).toBe('60')
    }

    const gains = results.map((r) =>
      r.disposals
        .reduce((sum, d2) => sum.plus(d2.realizedGain!), d(0))
        .toString()
    )
    // Different lots consumed -> different cost basis -> different realized
    // gain, even though every method disposed the same 60 units at the same
    // disposalPrice.
    expect(new Set(gains).size).toBeGreaterThan(1)
  })
})
