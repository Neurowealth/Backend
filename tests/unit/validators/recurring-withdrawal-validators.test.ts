import {
  createRecurringWithdrawalSchema,
  updateRecurringWithdrawalSchema,
} from '../../../src/validators/recurring-withdrawal-validators'

describe('recurring-withdrawal-validators', () => {
  const validUuid = '11111111-1111-4111-8111-111111111111'

  it('validates a correct FIXED recurring withdrawal schema', () => {
    const valid = {
      userId: validUuid,
      destinationAddress: 'GDESTINATION1234567890',
      assetSymbol: 'USDC',
      amountMode: 'FIXED',
      amount: 100,
      cadence: 'MONTHLY',
      confirmed: true,
    }

    const result = createRecurringWithdrawalSchema.safeParse(valid)
    expect(result.success).toBe(true)
  })

  it('validates a correct PERCENT_OF_BALANCE recurring withdrawal schema', () => {
    const valid = {
      userId: validUuid,
      destinationAddress: 'GDESTINATION1234567890',
      assetSymbol: 'USDC',
      amountMode: 'PERCENT_OF_BALANCE',
      percentage: 25,
      cadence: 'WEEKLY',
      confirmed: true,
    }

    const result = createRecurringWithdrawalSchema.safeParse(valid)
    expect(result.success).toBe(true)
  })

  it('fails if confirmed is missing or false', () => {
    const invalid = {
      userId: validUuid,
      destinationAddress: 'GDESTINATION1234567890',
      assetSymbol: 'USDC',
      amountMode: 'FIXED',
      amount: 100,
      cadence: 'MONTHLY',
      confirmed: false,
    }

    const result = createRecurringWithdrawalSchema.safeParse(invalid)
    expect(result.success).toBe(false)
  })

  it('fails if amountMode is FIXED but amount is missing', () => {
    const invalid = {
      userId: validUuid,
      destinationAddress: 'GDESTINATION1234567890',
      assetSymbol: 'USDC',
      amountMode: 'FIXED',
      cadence: 'MONTHLY',
      confirmed: true,
    }

    const result = createRecurringWithdrawalSchema.safeParse(invalid)
    expect(result.success).toBe(false)
  })

  it('validates update schema', () => {
    const validUpdate = {
      destinationAddress: 'GNEWDESTINATION',
      status: 'PAUSED',
    }

    const result = updateRecurringWithdrawalSchema.safeParse(validUpdate)
    expect(result.success).toBe(true)
  })
})
