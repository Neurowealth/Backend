import { z } from 'zod'

const categoryEnum = z.enum([
  'ACCOUNT',
  'TRANSACTION',
  'TAX',
  'TECHNICAL',
  'OTHER',
])

const statusEnum = z.enum([
  'OPEN',
  'IN_PROGRESS',
  'AWAITING_USER',
  'RESOLVED',
  'CLOSED',
])

const priorityEnum = z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT'])

export const createSupportTicketSchema = z.object({
  subject: z.string().min(3).max(200),
  category: categoryEnum,
  body: z.string().min(5).max(5000),
  priority: priorityEnum.optional().default('MEDIUM'),
  contextRef: z.string().optional(),
  attachmentRefs: z.array(z.string()).optional(),
})

export const replySupportTicketSchema = z.object({
  body: z.string().min(1).max(5000),
  attachmentRefs: z.array(z.string()).optional(),
})

export const adminReplySupportTicketSchema = z.object({
  body: z.string().min(1).max(5000),
  attachmentRefs: z.array(z.string()).optional(),
  internal: z.boolean().optional().default(false),
})

export const adminUpdateSupportTicketSchema = z.object({
  status: statusEnum.optional(),
  priority: priorityEnum.optional(),
  assignedTo: z.string().nullable().optional(),
})

export const supportTicketIdParamSchema = z.object({
  id: z.string().uuid('Invalid ticket ID'),
})

export type CreateSupportTicketInput = z.infer<typeof createSupportTicketSchema>
export type ReplySupportTicketInput = z.infer<typeof replySupportTicketSchema>
export type AdminReplySupportTicketInput = z.infer<
  typeof adminReplySupportTicketSchema
>
export type AdminUpdateSupportTicketInput = z.infer<
  typeof adminUpdateSupportTicketSchema
>
