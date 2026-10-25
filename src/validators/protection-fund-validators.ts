import { z } from 'zod'

export const declareEventSchema = z.object({
  protocolName: z.string().min(1).max(100),
  cause: z.enum(['EXPLOIT', 'INSOLVENCY', 'GOVERNANCE_FAILURE']),
  lossWindowStart: z.string().datetime(),
  lossWindowEnd: z.string().datetime(),
  totalPlatformExposure: z.number().positive(),
  description: z.string().min(1).max(2000),
})

export const reviewEventSchema = z.object({
  approved: z.boolean(),
})

export const eventIdParamSchema = z.object({
  eventId: z.string().uuid(),
})
