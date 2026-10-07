import { z } from 'zod'
import { SubAccountPermission } from '@prisma/client'

const PERMISSION_VALUES = Object.values(SubAccountPermission)

export const bulkSubAccountOpSchema = z.object({
  action: z.enum(['create', 'update', 'setPermission', 'setLimit', 'revoke']),
  childUserId: z.string().uuid().optional(),
  subAccountId: z.string().uuid().optional(),
  payload: z
    .object({
      permissions: z
        .array(z.enum(PERMISSION_VALUES as [string, ...string[]]))
        .optional(),
      dailyLimit: z.number().positive().nullable().optional(),
      transactionLimit: z.number().positive().nullable().optional(),
    })
    .optional(),
})

export const bulkSubAccountsSchema = z.object({
  operations: z.array(bulkSubAccountOpSchema).min(1),
  atomic: z.boolean().optional().default(false),
})

export type BulkSubAccountOp = z.infer<typeof bulkSubAccountOpSchema>
export type BulkSubAccountsInput = z.infer<typeof bulkSubAccountsSchema>
