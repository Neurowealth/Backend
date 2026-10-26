import { z } from 'zod'

export const goalIdParamSchema = z.object({
  id: z.string().uuid('Invalid goal ID format'),
})

export const goalFundingModeSchema = z.enum(['SEQUENTIAL', 'WEIGHTED'])

export const createGoalSchema = z
  .object({
    targetAmount: z.number().positive('targetAmount must be greater than 0'),
    targetDate: z.coerce.date().refine((date) => date.getTime() > Date.now(), {
      message: 'targetDate must be in the future',
    }),
    startingAmount: z.number().nonnegative().optional(),
    positionId: z.string().uuid().optional(),
    riskCeiling: z.number().min(0).max(100).optional(),
    includeExternalHoldings: z.boolean().default(false),
    priority: z.number().int().min(1).max(10000).optional(),
    allocationWeight: z.coerce
      .number()
      .positive('allocationWeight must be greater than 0')
      .optional(),
    fundingMode: goalFundingModeSchema.optional(),
  })
  .refine(
    (data) =>
      data.startingAmount === undefined ||
      data.targetAmount > data.startingAmount,
    {
      message: 'targetAmount must be greater than startingAmount',
      path: ['targetAmount'],
    }
  )

export const updateGoalSchema = z
  .object({
    targetAmount: z
      .number()
      .positive('targetAmount must be greater than 0')
      .optional(),
    targetDate: z.coerce.date().optional(),
    riskCeiling: z.number().min(0).max(100).optional(),
    includeExternalHoldings: z.boolean().optional(),
    priority: z.number().int().min(1).max(10000).optional(),
    allocationWeight: z.coerce
      .number()
      .positive('allocationWeight must be greater than 0')
      .optional(),
    fundingMode: goalFundingModeSchema.optional(),
  })
  .refine(
    (data) =>
      data.targetAmount !== undefined ||
      data.targetDate !== undefined ||
      data.riskCeiling !== undefined ||
      data.includeExternalHoldings !== undefined ||
      data.priority !== undefined ||
      data.allocationWeight !== undefined ||
      data.fundingMode !== undefined,
    {
      message:
        'At least one of targetAmount, targetDate, riskCeiling, priority, allocationWeight, fundingMode must be provided',
    }
  )
  .refine(
    (data) =>
      data.targetDate === undefined || data.targetDate.getTime() > Date.now(),
    {
      message: 'targetDate must be in the future',
      path: ['targetDate'],
    }
  )

export const reassignGoalSchema = z.object({
  toGoalId: z.string().uuid('Invalid destination goal ID format'),
  amount: z.coerce.number().positive('Reassign amount must be greater than 0'),
})
