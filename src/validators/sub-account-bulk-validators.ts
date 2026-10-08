import { z } from 'zod'
import { SubAccountPermission } from '@prisma/client'

export const MAX_BULK_BATCH_SIZE = (() => {
  const configured = Number(process.env.SUB_ACCOUNT_MAX_BATCH_SIZE)
  return Number.isInteger(configured) && configured > 0 && configured <= 100
    ? configured
    : 100
})()
const permissions = z.array(z.enum(SubAccountPermission)).min(1).max(4)
const limit = z.number().positive().finite()
export const createSubAccountSchema = z.object({
  childUserId: z.string().uuid(),
  permissions,
  dailyLimit: limit.optional(),
  transactionLimit: limit.optional(),
})
export const updatePermissionsSchema = z.object({ permissions })
export const updateLimitsSchema = z
  .object({
    dailyLimit: limit.nullable().optional(),
    transactionLimit: limit.nullable().optional(),
  })
  .refine(
    (data) =>
      data.dailyLimit !== undefined || data.transactionLimit !== undefined,
    'At least one limit is required'
  )
const target = {
  childUserId: z.string().uuid().optional(),
  subAccountId: z.string().uuid().optional(),
}
const updatePayload = z
  .object({
    permissions: permissions.optional(),
    dailyLimit: limit.nullable().optional(),
    transactionLimit: limit.nullable().optional(),
  })
  .refine(
    (data) => Object.keys(data).length > 0,
    'At least one update is required'
  )
export const bulkSubAccountOpSchema = z
  .discriminatedUnion('action', [
    z.object({
      action: z.literal('create'),
      childUserId: z.string().uuid(),
      payload: createSubAccountSchema.omit({ childUserId: true }),
    }),
    z.object({
      action: z.literal('update'),
      ...target,
      payload: updatePayload,
    }),
    z.object({
      action: z.literal('setPermission'),
      ...target,
      payload: updatePermissionsSchema,
    }),
    z.object({
      action: z.literal('setLimit'),
      ...target,
      payload: updateLimitsSchema,
    }),
    z.object({ action: z.literal('revoke'), ...target }),
  ])
  .refine(
    (op) =>
      op.action === 'create' ||
      Boolean(op.childUserId) !== Boolean(op.subAccountId),
    'Specify exactly one childUserId or subAccountId'
  )

// Rows are deliberately validated inside the batch loop, so one malformed row
// cannot prevent valid rows from succeeding in non-atomic mode.
export const bulkSubAccountsSchema = z.object({
  operations: z.array(z.unknown()).min(1),
  atomic: z.boolean().default(false),
})
export type BulkSubAccountOp = z.infer<typeof bulkSubAccountOpSchema>
export type BulkSubAccountsInput = z.infer<typeof bulkSubAccountsSchema>
