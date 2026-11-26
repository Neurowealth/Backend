import { z } from 'zod'

/** Strict query validation for the admin audit export endpoint. */
export const adminAuditExportQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  from: z.string().datetime({ offset: true }).optional(),
  startDate: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  endDate: z.string().datetime({ offset: true }).optional(),
  action: z.string().min(1).optional(),
  adminKeyId: z.string().uuid().optional(),
  result: z.enum(['success', 'failure']).optional(),
  format: z.enum(['json', 'csv']).default('json'),
})

export type AdminAuditExportQuery = z.infer<typeof adminAuditExportQuerySchema>
