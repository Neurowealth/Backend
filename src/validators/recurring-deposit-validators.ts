import { z } from 'zod'

const depositCadenceEnum = z.enum(['WEEKLY', 'BIWEEKLY', 'MONTHLY'])
const planStatusEnum = z.enum(['ACTIVE', 'PAUSED', 'CANCELLED'])
const contributionPolicyEnum = z.enum(['FIXED', 'ADAPTIVE'])
const catchUpModeEnum = z.enum(['SKIP', 'ACCUMULATE', 'RETRY'])

/**
 * Allocation map: { protocol: weightPercent }.
 * Weights must be positive and sum to ~100.
 */
const allocationMapSchema = z
  .record(z.string().min(1), z.number().positive())
  .refine(
    (map) => {
      const total = Object.values(map).reduce((s, w) => s + w, 0)
      return Math.abs(total - 100) <= 0.01
    },
    { message: 'Allocation weights must sum to 100' }
  )
  .optional()

export const createRecurringDepositSchema = z
  .object({
    userId: z.string().uuid(),
    amount: z.number().positive(),
    assetSymbol: z.string().min(1),
    cadence: depositCadenceEnum,
    confirmed: z.literal(true).refine((val) => val === true, {
      message:
        'You must confirm this recurring deposit. Set confirmed: true after reviewing the schedule.',
    }),
    // ── Smart DCA fields (#311) ────────────────────────────────────────
    policy: contributionPolicyEnum.optional().default('FIXED'),
    catchUpMode: catchUpModeEnum.optional().default('RETRY'),
    pauseOnDrawdownPct: z.number().positive().max(100).optional().nullable(),
    doubleOnDrawdown: z.boolean().optional().default(false),
    allocationMap: allocationMapSchema,
  })
  .refine(
    (data) => {
      // Adaptive policy without bounds is allowed (uses defaults), but
      // pauseOnDrawdownPct without ADAPTIVE policy is a no-op warning.
      return true
    },
    { message: 'Invalid configuration' }
  )

export const updateRecurringDepositSchema = z.object({
  amount: z.number().positive().optional(),
  cadence: depositCadenceEnum.optional(),
  status: planStatusEnum.optional(),
  // ── Smart DCA fields (#311) ──────────────────────────────────────────
  policy: contributionPolicyEnum.optional(),
  catchUpMode: catchUpModeEnum.optional(),
  pauseOnDrawdownPct: z.number().positive().max(100).optional().nullable(),
  doubleOnDrawdown: z.boolean().optional(),
  allocationMap: allocationMapSchema,
})

export const recurringDepositIdParamSchema = z.object({
  id: z.string().uuid('Invalid recurring deposit plan ID'),
})

export const recurringDepositUserParamSchema = z.object({
  userId: z.string().uuid('Invalid user ID'),
})

/**
 * Query params for the preview endpoint.
 */
export const previewQuerySchema = z.object({
  runs: z.coerce.number().int().min(1).max(52).optional().default(12),
})

/**
 * Query params for the run ledger endpoint.
 */
export const runLedgerQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
})

export type CreateRecurringDepositInput = z.infer<
  typeof createRecurringDepositSchema
>
export type UpdateRecurringDepositInput = z.infer<
  typeof updateRecurringDepositSchema
>
