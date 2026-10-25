import {
  bestExecutionQuoteQuerySchema,
  createFiatOrderSchema,
  fiatQuoteSchema,
} from '../../../src/validators/fiat-validators'
import { onChainAmountSchema } from '../../../src/validators/common-validators'
import {
  MAX_CONTRACT_AMOUNT,
  MAX_FIAT_AMOUNT,
  MIN_FIAT_AMOUNT,
  MIN_CONTRACT_AMOUNT,
} from '../../../src/config/financial-limits'

const quote = {
  direction: 'ON_RAMP',
  fiatAmount: 100,
  fiatCurrency: 'usd',
  assetSymbol: 'USDC',
}

describe('fiat request boundaries', () => {
  it('accepts inclusive fiat amount boundaries and normalizes currency', () => {
    for (const fiatAmount of [MIN_FIAT_AMOUNT, MAX_FIAT_AMOUNT]) {
      const parsed = fiatQuoteSchema.safeParse({ ...quote, fiatAmount })
      expect(parsed.success).toBe(true)
      if (parsed.success) expect(parsed.data.fiatCurrency).toBe('USD')
    }
  })

  it.each([MIN_FIAT_AMOUNT - 0.01, MAX_FIAT_AMOUNT + 0.01, Infinity])(
    'rejects fiat amount %s',
    (fiatAmount) => {
      expect(fiatQuoteSchema.safeParse({ ...quote, fiatAmount }).success).toBe(
        false
      )
      expect(
        createFiatOrderSchema.safeParse({
          ...quote,
          fiatAmount,
          userId: '11111111-1111-4111-8111-111111111111',
        }).success
      ).toBe(false)
    }
  )

  it('coerces query amounts but applies the same finite range', () => {
    expect(
      bestExecutionQuoteQuerySchema.safeParse({
        ...quote,
        fiatAmount: String(MIN_FIAT_AMOUNT),
      }).success
    ).toBe(true)
    expect(
      bestExecutionQuoteQuerySchema.safeParse({
        ...quote,
        fiatAmount: String(MAX_FIAT_AMOUNT + 1),
      }).success
    ).toBe(false)
  })

  it.each(['US', 'US1', '1SD', 'US D'])(
    'rejects invalid currency %s',
    (code) => {
      expect(
        fiatQuoteSchema.safeParse({ ...quote, fiatCurrency: code }).success
      ).toBe(false)
    }
  )
})

describe('on-chain amount boundary', () => {
  it('accepts positive finite values through the exact stroop-safe maximum', () => {
    expect(onChainAmountSchema.safeParse(MIN_CONTRACT_AMOUNT).success).toBe(
      true
    )
    expect(onChainAmountSchema.safeParse(MAX_CONTRACT_AMOUNT).success).toBe(
      true
    )
  })

  it.each([0, -1, Infinity, NaN, MAX_CONTRACT_AMOUNT + 1])(
    'rejects unsafe on-chain amount %s',
    (amount) => {
      expect(onChainAmountSchema.safeParse(amount).success).toBe(false)
    }
  )
})
