import { calculateRoundUp } from '../../../src/roundup/service'

describe('Round-Up Math Calculation', () => {
  it('calculates standard round-up for fractional dollar purchase', () => {
    const result = calculateRoundUp(10.25, 1.0, 1.0)
    expect(result.purchaseAmount).toBe(10.25)
    expect(result.roundToNearest).toBe(1.0)
    expect(result.multiplier).toBe(1.0)
    expect(result.roundUpAmount).toBe(0.75)
    expect(result.totalRoundUp).toBe(0.75)
  })

  it('calculates round-up with 2x boost multiplier', () => {
    const result = calculateRoundUp(10.25, 1.0, 2.0)
    expect(result.roundUpAmount).toBe(0.75)
    expect(result.multiplier).toBe(2.0)
    expect(result.totalRoundUp).toBe(1.5)
  })

  it('returns zero round-up when purchase amount is already an exact increment', () => {
    const result = calculateRoundUp(15.0, 1.0, 2.0)
    expect(result.roundUpAmount).toBe(0)
    expect(result.totalRoundUp).toBe(0)
  })

  it('handles custom roundToNearest of 5.00', () => {
    const result = calculateRoundUp(12.3, 5.0, 1.0)
    expect(result.roundUpAmount).toBe(2.7)
    expect(result.totalRoundUp).toBe(2.7)
  })

  it('returns zero round-up when purchase amount is an exact multiple of custom increment', () => {
    const result = calculateRoundUp(25.0, 5.0, 3.0)
    expect(result.roundUpAmount).toBe(0)
    expect(result.totalRoundUp).toBe(0)
  })

  it('clamps multiplier between 1.0 and 10.0', () => {
    const lowMultiplier = calculateRoundUp(10.25, 1.0, 0.2)
    expect(lowMultiplier.multiplier).toBe(1.0)
    expect(lowMultiplier.totalRoundUp).toBe(0.75)

    const highMultiplier = calculateRoundUp(10.25, 1.0, 50.0)
    expect(highMultiplier.multiplier).toBe(10.0)
    expect(highMultiplier.totalRoundUp).toBe(7.5)
  })

  it('handles zero or negative purchase amounts gracefully', () => {
    const zeroResult = calculateRoundUp(0, 1.0, 1.0)
    expect(zeroResult.roundUpAmount).toBe(0)
    expect(zeroResult.totalRoundUp).toBe(0)

    const negativeResult = calculateRoundUp(-5.5, 1.0, 1.0)
    expect(negativeResult.roundUpAmount).toBe(0)
    expect(negativeResult.totalRoundUp).toBe(0)
  })

  it('handles fractional cents rounding cleanly without precision drift', () => {
    const result = calculateRoundUp(10.01, 1.0, 3.0)
    expect(result.roundUpAmount).toBe(0.99)
    expect(result.totalRoundUp).toBe(2.97)
  })
})
