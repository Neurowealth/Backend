import { z } from 'zod'
import {
  MAX_CONTRACT_AMOUNT,
  MIN_CONTRACT_AMOUNT,
} from '../config/financial-limits'

/**
 * Stroop precision: STROOPS_PER_TOKEN is 1e7 in financial-limits.ts.
 * Kept as a literal because `Math.log10(1e7)` is not guaranteed to be
 * exactly 7 across engines, and toFixed truncates a fractional argument.
 */
const MAX_DECIMAL_PLACES = 7

/**
 * Precision check for stroop-denominated amounts.
 *
 * `Number.isInteger(amount * STROOPS_PER_TOKEN)` is unreliable in IEEE-754:
 * 19.99 * 1e7 is 199899999.99999997, so ordinary deposits were rejected.
 * Rounding to the token's decimal places and comparing the value back is
 * exact for the amounts this schema accepts, and unlike a regex on
 * `amount.toString()` it still accepts MIN_CONTRACT_AMOUNT (1e-7), which
 * JavaScript prints in exponential notation.
 */
function hasAtMostSevenDecimals(amount: number): boolean {
  return Number(amount.toFixed(MAX_DECIMAL_PLACES)) === amount
}

export const onChainAmountSchema = z
  .number()
  .finite('amount must be a finite number')
  .min(MIN_CONTRACT_AMOUNT, `amount must be at least ${MIN_CONTRACT_AMOUNT}`)
  .refine(hasAtMostSevenDecimals, 'amount supports at most 7 decimal places')
  .max(MAX_CONTRACT_AMOUNT, `amount must not exceed ${MAX_CONTRACT_AMOUNT}`)

export const userIdParamSchema = z.object({
  userId: z.string().uuid('Invalid user ID format'),
})
