import {
  createRecurringWithdrawalSchema,
  updateRecurringWithdrawalSchema,
  recurringWithdrawalIdParamSchema,
  recurringWithdrawalUserParamSchema,
} from '../../../src/validators/recurring-withdrawal-validators'

declare const describe: any
declare const it: any
declare const expect: any

describe('recurring-withdrawal-validators', () => {
  describe('createRecurringWithdrawalSchema', () => {
    const validBase = {
      userId: '550e8400-e29b-41d4-a716-446655440000',
      destinationAddress:
        'GBND65A3X4K7F4567890123456789012345678901234567890123456',
      assetSymbol: 'USDC',
      amountMode: 'FIXED',
      amount: 100,
      cadence: 'WEEKLY',
    }

    it('accepts a valid fixed withdrawal payload with confirmed: true', () => {
      const result = createRecurringWithdrawalSchema.safeParse({
        ...validBase,
        confirmed: true,
      })
      expect(result.success).toBe(true)
    })

    it('accepts YIELD_ONLY mode without explicit amount', () => {
      const result = createRecurringWithdrawalSchema.safeParse({
        userId: validBase.userId,
        destinationAddress: validBase.destinationAddress,
        assetSymbol: 'USDC',
        amountMode: 'YIELD_ONLY',
        cadence: 'MONTHLY',
        confirmed: true,
      })
      expect(result.success).toBe(true)
    })

    it('accepts PERCENT_OF_BALANCE mode with valid percentage', () => {
      const result = createRecurringWithdrawalSchema.safeParse({
        ...validBase,
        amountMode: 'PERCENT_OF_BALANCE',
        amount: 25,
        confirmed: true,
      })
      expect(result.success).toBe(true)
    })

    it('rejects PERCENT_OF_BALANCE greater than 100', () => {
      const result = createRecurringWithdrawalSchema.safeParse({
        ...validBase,
        amountMode: 'PERCENT_OF_BALANCE',
        amount: 150,
        confirmed: true,
      })
      expect(result.success).toBe(false)
    })

    it('rejects FIXED mode without amount', () => {
      const result = createRecurringWithdrawalSchema.safeParse({
        userId: validBase.userId,
        destinationAddress: validBase.destinationAddress,
        assetSymbol: 'USDC',
        amountMode: 'FIXED',
        cadence: 'WEEKLY',
        confirmed: true,
      })
      expect(result.success).toBe(false)
    })

    it('rejects when confirmed is missing', () => {
      const result = createRecurringWithdrawalSchema.safeParse(validBase)
      expect(result.success).toBe(false)
    })

    it('rejects when confirmed is false', () => {
      const result = createRecurringWithdrawalSchema.safeParse({
        ...validBase,
        confirmed: false,
      })
      expect(result.success).toBe(false)
    })

    it('rejects empty destinationAddress', () => {
      const result = createRecurringWithdrawalSchema.safeParse({
        ...validBase,
        destinationAddress: '',
        confirmed: true,
      })
      expect(result.success).toBe(false)
    })

    it('rejects invalid userId format', () => {
      const result = createRecurringWithdrawalSchema.safeParse({
        ...validBase,
        userId: 'not-a-uuid',
        confirmed: true,
      })
      expect(result.success).toBe(false)
    })

    it('rejects invalid cadence', () => {
      const result = createRecurringWithdrawalSchema.safeParse({
        ...validBase,
        cadence: 'DAILY',
        confirmed: true,
      })
      expect(result.success).toBe(false)
    })

    it('accepts optional minAmount', () => {
      const result = createRecurringWithdrawalSchema.safeParse({
        ...validBase,
        minAmount: 10,
        confirmed: true,
      })
      expect(result.success).toBe(true)
    })
  })

  describe('updateRecurringWithdrawalSchema', () => {
    it('accepts partial status update', () => {
      const result = updateRecurringWithdrawalSchema.safeParse({
        status: 'PAUSED',
      })
      expect(result.success).toBe(true)
    })

    it('accepts destination address update', () => {
      const result = updateRecurringWithdrawalSchema.safeParse({
        destinationAddress:
          'GNEWDESTINATIONADDRESS1234567890123456789012345678901234',
      })
      expect(result.success).toBe(true)
    })

    it('rejects empty destination address', () => {
      const result = updateRecurringWithdrawalSchema.safeParse({
        destinationAddress: '',
      })
      expect(result.success).toBe(false)
    })

    it('accepts amount and cadence updates', () => {
      const result = updateRecurringWithdrawalSchema.safeParse({
        amount: 250,
        cadence: 'MONTHLY',
        minAmount: 20,
      })
      expect(result.success).toBe(true)
    })
  })

  describe('param schemas', () => {
    it('recurringWithdrawalIdParamSchema accepts valid id', () => {
      const result = recurringWithdrawalIdParamSchema.safeParse({
        id: 'plan-12345',
      })
      expect(result.success).toBe(true)
    })

    it('recurringWithdrawalUserParamSchema validates uuid', () => {
      const result = recurringWithdrawalUserParamSchema.safeParse({
        userId: '550e8400-e29b-41d4-a716-446655440000',
      })
      expect(result.success).toBe(true)

      const invalid = recurringWithdrawalUserParamSchema.safeParse({
        userId: 'invalid-uuid',
      })
      expect(invalid.success).toBe(false)
    })
  })
})
