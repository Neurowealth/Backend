import {
  createRecurringDepositSchema,
  updateRecurringDepositSchema,
} from '../../../src/validators/recurring-deposit-validators'

declare const describe: any
declare const it: any
declare const expect: any

describe('recurring-deposit-validators', () => {
  describe('createRecurringDepositSchema', () => {
    const validBase = {
      userId: '550e8400-e29b-41d4-a716-446655440000',
      amount: 50,
      assetSymbol: 'USDC',
      cadence: 'WEEKLY',
    }

    it('accepts a valid payload with confirmed: true', () => {
      const result = createRecurringDepositSchema.safeParse({
        ...validBase,
        confirmed: true,
      })
      expect(result.success).toBe(true)
    })

    it('rejects when confirmed is missing', () => {
      const result = createRecurringDepositSchema.safeParse(validBase)
      expect(result.success).toBe(false)
    })

    it('rejects when confirmed is false', () => {
      const result = createRecurringDepositSchema.safeParse({
        ...validBase,
        confirmed: false,
      })
      expect(result.success).toBe(false)
    })

    it('rejects negative amount', () => {
      const result = createRecurringDepositSchema.safeParse({
        ...validBase,
        amount: -10,
        confirmed: true,
      })
      expect(result.success).toBe(false)
    })

    it('rejects zero amount', () => {
      const result = createRecurringDepositSchema.safeParse({
        ...validBase,
        amount: 0,
        confirmed: true,
      })
      expect(result.success).toBe(false)
    })

    it('rejects invalid cadence', () => {
      const result = createRecurringDepositSchema.safeParse({
        ...validBase,
        cadence: 'DAILY',
        confirmed: true,
      })
      expect(result.success).toBe(false)
    })

    it('accepts BIWEEKLY cadence', () => {
      const result = createRecurringDepositSchema.safeParse({
        ...validBase,
        cadence: 'BIWEEKLY',
        confirmed: true,
      })
      expect(result.success).toBe(true)
    })

    it('accepts MONTHLY cadence', () => {
      const result = createRecurringDepositSchema.safeParse({
        ...validBase,
        cadence: 'MONTHLY',
        confirmed: true,
      })
      expect(result.success).toBe(true)
    })

    it('rejects invalid userId format', () => {
      const result = createRecurringDepositSchema.safeParse({
        ...validBase,
        userId: 'not-a-uuid',
        confirmed: true,
      })
      expect(result.success).toBe(false)
    })

    it('rejects empty assetSymbol', () => {
      const result = createRecurringDepositSchema.safeParse({
        ...validBase,
        assetSymbol: '',
        confirmed: true,
      })
      expect(result.success).toBe(false)
    })
  })

  describe('updateRecurringDepositSchema', () => {
    it('accepts empty update (no changes)', () => {
      const result = updateRecurringDepositSchema.safeParse({})
      expect(result.success).toBe(true)
    })

    it('accepts valid amount update', () => {
      const result = updateRecurringDepositSchema.safeParse({ amount: 100 })
      expect(result.success).toBe(true)
    })

    it('accepts valid status update', () => {
      const result = updateRecurringDepositSchema.safeParse({
        status: 'PAUSED',
      })
      expect(result.success).toBe(true)
    })

    it('accepts valid cadence update', () => {
      const result = updateRecurringDepositSchema.safeParse({
        cadence: 'MONTHLY',
      })
      expect(result.success).toBe(true)
    })

    it('rejects negative amount', () => {
      const result = updateRecurringDepositSchema.safeParse({ amount: -5 })
      expect(result.success).toBe(false)
    })

    it('rejects invalid status', () => {
      const result = updateRecurringDepositSchema.safeParse({
        status: 'DELETED',
      })
      expect(result.success).toBe(false)
    })
  })
})
