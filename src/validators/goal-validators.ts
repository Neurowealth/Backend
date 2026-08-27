import { z } from 'zod'

export const goalIdParamSchema = z.object({
  id: z.string().uuid('Invalid goal ID format'),
})

export const createGoalSchema = z
  .object({
    targetAmount: z.number().positive('targetAmount must be greater than 0'),
    targetDate: z.coerce.date().refine((date) => date.getTime() > Date.now(), {
      message: 'targetDate must be in the future',
    }),
    startingAmount: z.number().nonnegative().optional(),
    positionId: z.string().uuid().optional(),
    riskCeiling: z.number().min(0).max(100).optional(),
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
  })
  .refine(
    (data) =>
      data.targetAmount !== undefined ||
      data.targetDate !== undefined ||
      data.riskCeiling !== undefined,
    {
      message:
        'At least one of targetAmount, targetDate, riskCeiling must be provided',
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
