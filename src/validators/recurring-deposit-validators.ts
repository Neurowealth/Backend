import { z } from 'zod'

const depositCadenceEnum = z.enum(['WEEKLY', 'BIWEEKLY', 'MONTHLY'])
const planStatusEnum = z.enum(['ACTIVE', 'PAUSED', 'CANCELLED'])

export const createRecurringDepositSchema = z.object({
  userId: z.string().uuid(),
  amount: z.number().positive(),
  assetSymbol: z.string().min(1),
  cadence: depositCadenceEnum,
  confirmed: z.literal(true).refine((val) => val === true, {
    message:
      'You must confirm this recurring deposit. Set confirmed: true after reviewing the schedule.',
  }),
})

export const updateRecurringDepositSchema = z.object({
  amount: z.number().positive().optional(),
  cadence: depositCadenceEnum.optional(),
  status: planStatusEnum.optional(),
})

export const recurringDepositIdParamSchema = z.object({
  id: z.string().uuid('Invalid recurring deposit plan ID'),
})

export const recurringDepositUserParamSchema = z.object({
  userId: z.string().uuid('Invalid user ID'),
})

export type CreateRecurringDepositInput = z.infer<
  typeof createRecurringDepositSchema
>
export type UpdateRecurringDepositInput = z.infer<
  typeof updateRecurringDepositSchema
>
