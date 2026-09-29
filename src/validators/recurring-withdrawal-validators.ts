import { z } from 'zod'

const withdrawalCadenceEnum = z.enum(['WEEKLY', 'BIWEEKLY', 'MONTHLY'])
const withdrawalStatusEnum = z.enum(['ACTIVE', 'PAUSED', 'CANCELLED'])
const amountModeEnum = z.enum(['FIXED', 'YIELD_ONLY', 'PERCENT_OF_BALANCE'])

/**
 * Validator schema for creating a recurring withdrawal plan.
 */
export const createRecurringWithdrawalSchema = z
  .object({
    userId: z.string().uuid('Invalid user ID'),
    destinationAddress: z.string().min(1, 'Destination address is required'),
    assetSymbol: z.string().min(1, 'Asset symbol is required'),
    amountMode: amountModeEnum.default('FIXED'),
    amount: z.number().positive('Amount must be positive').optional(),
    amountValue: z
      .number()
      .positive('Amount value must be positive')
      .optional(),
    minAmount: z
      .number()
      .positive('Minimum amount must be positive')
      .optional(),
    cadence: withdrawalCadenceEnum,
    confirmed: z.literal(true).refine((val) => val === true, {
      message:
        'You must confirm this recurring withdrawal. Set confirmed: true after reviewing the schedule.',
    }),
  })
  .refine(
    (data) => {
      const resolved = data.amount ?? data.amountValue
      if (
        data.amountMode === 'FIXED' ||
        data.amountMode === 'PERCENT_OF_BALANCE'
      ) {
        return resolved != null && resolved > 0
      }
      return true
    },
    {
      message:
        'Amount is required when amountMode is FIXED or PERCENT_OF_BALANCE',
      path: ['amount'],
    }
  )
  .refine(
    (data) => {
      if (data.amountMode === 'PERCENT_OF_BALANCE') {
        const val = data.amount ?? data.amountValue
        return val != null && val > 0 && val <= 100
      }
      return true
    },
    {
      message: 'Percentage must be between 0 and 100',
      path: ['amount'],
    }
  )

/**
 * Validator schema for updating an existing recurring withdrawal plan.
 */
export const updateRecurringWithdrawalSchema = z.object({
  destinationAddress: z
    .string()
    .min(1, 'Destination address cannot be empty')
    .optional(),
  amountMode: amountModeEnum.optional(),
  amount: z.number().positive('Amount must be positive').optional(),
  amountValue: z.number().positive('Amount value must be positive').optional(),
  minAmount: z
    .number()
    .positive('Minimum amount must be positive')
    .nullable()
    .optional(),
  cadence: withdrawalCadenceEnum.optional(),
  status: withdrawalStatusEnum.optional(),
})

/**
 * Validator for plan ID route parameter.
 */
export const recurringWithdrawalIdParamSchema = z.object({
  id: z.string().min(1, 'Invalid recurring withdrawal plan ID'),
})

/**
 * Validator for user ID route parameter.
 */
export const recurringWithdrawalUserParamSchema = z.object({
  userId: z.string().uuid('Invalid user ID'),
})

export type CreateRecurringWithdrawalInput = z.infer<
  typeof createRecurringWithdrawalSchema
>
export type UpdateRecurringWithdrawalInput = z.infer<
  typeof updateRecurringWithdrawalSchema
>
