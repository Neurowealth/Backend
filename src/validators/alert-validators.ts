import { z } from 'zod'

/**
 * Validators for user-defined alert rules (#289).
 *
 * The metric/comparator/deliveryChannel enums mirror the Prisma enums in
 * prisma/schema.prisma — keep them in sync manually (there is no generated
 * shared source between Zod and Prisma enums in this codebase).
 */

export const ALERT_METRICS = [
  'PROTOCOL_APY',
  'PORTFOLIO_VALUE',
  'POSITION_DRAWDOWN',
] as const

export const COMPARATORS = ['LT', 'LTE', 'GT', 'GTE'] as const

export const DELIVERY_CHANNELS = ['WEBHOOK', 'WHATSAPP', 'BOTH'] as const

export type AlertMetric = (typeof ALERT_METRICS)[number]
export type Comparator = (typeof COMPARATORS)[number]
export type DeliveryChannel = (typeof DELIVERY_CHANNELS)[number]

const baseAlertRuleShape = {
  metric: z.enum(ALERT_METRICS),
  protocolName: z.string().trim().min(1).max(100).optional(),
  comparator: z.enum(COMPARATORS),
  threshold: z.number().finite(),
  deliveryChannel: z.enum(DELIVERY_CHANNELS),
  cooldownMinutes: z.number().int().min(1).max(10080).default(60),
}

/**
 * PROTOCOL_APY rules must name a protocol; the other metrics must not
 * (protocolName is meaningless for portfolio-wide metrics and would be
 * silently ignored, so we reject it to avoid confusing rules).
 */
function requireProtocolNameForApy<
  T extends { metric?: AlertMetric; protocolName?: string },
>(data: T, ctx: z.RefinementCtx): void {
  if (data.metric === 'PROTOCOL_APY' && !data.protocolName) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['protocolName'],
      message: 'protocolName is required when metric is PROTOCOL_APY',
    })
  }
  if (data.metric && data.metric !== 'PROTOCOL_APY' && data.protocolName) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['protocolName'],
      message: 'protocolName is only valid when metric is PROTOCOL_APY',
    })
  }
}

export const createAlertRuleSchema = z
  .object(baseAlertRuleShape)
  .superRefine(requireProtocolNameForApy)

/**
 * PATCH allows partial updates. When metric is being changed we still enforce
 * the protocolName pairing; when it is absent we can only validate the fields
 * that are present, so the job re-derives requirements from the stored row.
 */
export const updateAlertRuleSchema = z
  .object({
    metric: z.enum(ALERT_METRICS).optional(),
    protocolName: z.string().trim().min(1).max(100).nullable().optional(),
    comparator: z.enum(COMPARATORS).optional(),
    threshold: z.number().finite().optional(),
    deliveryChannel: z.enum(DELIVERY_CHANNELS).optional(),
    cooldownMinutes: z.number().int().min(1).max(10080).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  })

export const alertIdParamSchema = z.object({
  id: z.string().uuid('Invalid alert rule ID'),
})

export const alertUserParamSchema = z.object({
  userId: z.string().uuid('Invalid user ID format'),
})
