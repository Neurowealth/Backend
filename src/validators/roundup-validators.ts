import { z } from 'zod'

/**
 * Validation schema for updating round-up savings settings.
 */
export const updateRoundUpSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  roundToNearest: z
    .number()
    .positive('roundToNearest must be greater than 0')
    .max(100, 'roundToNearest must not exceed 100')
    .optional(),
  multiplier: z
    .number()
    .min(1, 'multiplier must be at least 1')
    .max(10, 'multiplier must not exceed 10')
    .optional(),
  targetGoalId: z.string().uuid('Invalid savings goal ID').nullable().optional(),
})

/**
 * Validation schema for triggering an on-demand sweep.
 */
export const triggerSweepSchema = z.object({
  force: z.boolean().optional(),
})

export type UpdateRoundUpSettingsInput = z.infer<
  typeof updateRoundUpSettingsSchema
>
export type TriggerSweepInput = z.infer<typeof triggerSweepSchema>
