import { publishStrategySchema } from '../../../src/validators/strategy-validators'

describe('publishStrategySchema tags/description', () => {
  it('accepts a short description and lowercase slug tags', () => {
    const result = publishStrategySchema.safeParse({
      label: 'My Strategy',
      description: 'Balanced Blend + DEX allocation',
      tags: ['conservative', 'diversified'],
    })
    expect(result.success).toBe(true)
  })

  it('rejects a description over 280 chars', () => {
    const result = publishStrategySchema.safeParse({
      label: 'My Strategy',
      description: 'x'.repeat(281),
    })
    expect(result.success).toBe(false)
  })

  it('rejects more than 5 tags', () => {
    const result = publishStrategySchema.safeParse({
      label: 'My Strategy',
      tags: ['a', 'b', 'c', 'd', 'e', 'f'],
    })
    expect(result.success).toBe(false)
  })
})
