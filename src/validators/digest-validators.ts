import { z } from 'zod'

/**
 * Validators for digest subscriptions (#365).
 *
 * Enums mirror the Prisma enums in prisma/schema.prisma — keep in sync manually
 * (there is no generated shared source between Zod and Prisma enums here).
 */

export const DIGEST_FREQUENCIES = ['DAILY', 'WEEKLY', 'MONTHLY'] as const

export const DIGEST_CHANNELS = [
  'WHATSAPP',
  'TELEGRAM',
  'EMAIL',
  'WEBHOOK',
] as const

export type DigestFrequency = (typeof DIGEST_FREQUENCIES)[number]
export type DigestChannel = (typeof DIGEST_CHANNELS)[number]

export const quietHoursSchema = z
  .object({
    startUtc: z.number().int().min(0).max(23),
    endUtc: z.number().int().min(0).max(23),
  })
  .refine((q) => q.startUtc !== q.endUtc, {
    message: 'quietHours.startUtc and endUtc must differ',
  })

const digestBaseShape = {
  frequency: z.enum(DIGEST_FREQUENCIES),
  channels: z
    .array(z.enum(DIGEST_CHANNELS))
    .min(1, 'At least one channel is required')
    .max(4),
  sendHourUtc: z.number().int().min(0).max(23).default(9),
  weeklyDayUtc: z.number().int().min(0).max(6).nullable().optional(),
  quietHours: quietHoursSchema.optional(),
  isActive: z.boolean().optional(),
}

function validateWeeklyConsistency<
  T extends { frequency?: DigestFrequency; weeklyDayUtc?: number | null },
>(data: T, ctx: z.RefinementCtx): void {
  if (data.frequency === 'WEEKLY' && data.weeklyDayUtc === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['weeklyDayUtc'],
      message: 'weeklyDayUtc is required when frequency is WEEKLY',
    })
  }
}

export const createDigestSubscriptionSchema = z
  .object(digestBaseShape)
  .superRefine(validateWeeklyConsistency)

export const updateDigestSubscriptionSchema = z
  .object(digestBaseShape)
  .partial()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  })
  .superRefine(validateWeeklyConsistency)

export const digestIdParamSchema = z.object({
  id: z.string().uuid('Invalid digest subscription ID'),
})

export const digestPreviewQuerySchema = z.object({
  frequency: z.enum(DIGEST_FREQUENCIES).default('WEEKLY'),
})
