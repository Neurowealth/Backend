import { z } from 'zod'

const withdrawalCadenceEnum = z.enum(['WEEKLY', 'BIWEEKLY', 'MONTHLY'])
const planStatusEnum = z.enum(['ACTIVE', 'PAUSED', 'CANCELLED'])
const amountModeEnum = z.enum(['FIXED', 'YIELD_ONLY', 'PERCENT_OF_BALANCE'])

export const createRecurringWithdrawalSchema = z
  .object({
    userId: z.string().uuid(),
    destinationAddress: z.string().min(1, 'Destination address is required'),
    assetSymbol: z.string().min(1, 'Asset symbol is required'),
    amountMode: amountModeEnum.default('FIXED'),
    amount: z.number().positive().optional(),
    percentage: z.number().min(0.01).max(100).optional(),
    cadence: withdrawalCadenceEnum,
    minAmount: z.number().positive().optional(),
    confirmed: z.literal(true).refine((val) => val === true, {
      message:
        'You must confirm this recurring withdrawal. Set confirmed: true after reviewing the schedule.',
    }),
  })
  .refine(
    (data) => {
      if (data.amountMode === 'FIXED') {
        return data.amount !== undefined && data.amount > 0
      }
      return true
    },
    {
      message: 'amount is required when amountMode is FIXED',
      path: ['amount'],
    }
  )
  .refine(
    (data) => {
      if (data.amountMode === 'PERCENT_OF_BALANCE') {
        return data.percentage !== undefined && data.percentage > 0
      }
      return true
    },
    {
      message: 'percentage is required when amountMode is PERCENT_OF_BALANCE',
      path: ['percentage'],
    }
  )

export const updateRecurringWithdrawalSchema = z.object({
  destinationAddress: z.string().min(1).optional(),
  amountMode: amountModeEnum.optional(),
  amount: z.number().positive().optional(),
  percentage: z.number().min(0.01).max(100).optional(),
  cadence: withdrawalCadenceEnum.optional(),
  minAmount: z.number().positive().optional(),
  status: planStatusEnum.optional(),
})

export const recurringWithdrawalIdParamSchema = z.object({
  id: z.string().uuid('Invalid recurring withdrawal plan ID'),
})

export const previewRecurringWithdrawalSchema = z.object({
  userId: z.string().uuid(),
  destinationAddress: z.string().min(1).optional(),
  assetSymbol: z.string().min(1),
  amountMode: amountModeEnum.default('FIXED'),
  amount: z.number().positive().optional(),
  percentage: z.number().min(0.01).max(100).optional(),
  cadence: withdrawalCadenceEnum,
  minAmount: z.number().positive().optional(),
})

export type CreateRecurringWithdrawalInput = z.infer<
  typeof createRecurringWithdrawalSchema
>
export type UpdateRecurringWithdrawalInput = z.infer<
  typeof updateRecurringWithdrawalSchema
>
