import { z } from 'zod'
import { onChainAmountSchema, userIdParamSchema } from './common-validators'

/**
 * #532 — request validation for the collateral loan surface.
 *
 * Amounts reuse `onChainAmountSchema` rather than inventing a second amount
 * type, so a loan cannot be requested with a precision the settlement path is
 * unable to represent. The bounds that matter for LENDING specifically (the
 * per-loan maximum, the collateral minimum) are enforced in the service,
 * where the config values live, instead of being frozen into a schema that
 * would silently disagree with the environment.
 */

const uuidParam = z.string().uuid('Invalid loan ID')

/** Stablecoin symbol: 2–12 letters/digits, no separators. */
const assetSymbolSchema = z
  .string()
  .min(2)
  .max(12)
  .regex(/^[A-Za-z0-9]+$/, 'Asset symbol must be alphanumeric')
  .transform((s) => s.toUpperCase())

export const loanIdParamSchema = z.object({ loanId: uuidParam })

export const positionIdParamSchema = z.object({
  positionId: z.string().uuid('Invalid position ID'),
})

export const originateLoanSchema = z.object({
  positionId: z.string().uuid('positionId must be a UUID'),
  amount: onChainAmountSchema,
  assetSymbol: assetSymbolSchema.default('USDC'),
  memo: z.string().max(280).optional(),
})

export const repayLoanSchema = z.object({
  // Omit, or pass 0, to clear the whole outstanding balance in one payment.
  // Zero is accepted deliberately: "repay it all" is a button, and a separate
  // "settle in full" flag would be a second way to say the same thing.
  amount: onChainAmountSchema.optional(),
})

export const listLoansQuerySchema = z.object({
  // Querystring values are always strings, so this is a string union that
  // transforms to a boolean rather than a boolean with a default — zod v4
  // would not coerce 'false' to false, and a caller passing includeClosed=
  // would silently get the opposite of what they asked for.
  includeClosed: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
})

export const borrowingCapacityQuerySchema = z.object({
  positionId: z.string().uuid('positionId must be a UUID'),
})

export { userIdParamSchema }
