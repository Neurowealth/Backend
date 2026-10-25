import { z } from 'zod'
import {
  MAX_CONTRACT_AMOUNT,
  MIN_CONTRACT_AMOUNT,
  STROOPS_PER_TOKEN,
} from '../config/financial-limits'

export const onChainAmountSchema = z
  .number()
  .finite('amount must be a finite number')
  .min(MIN_CONTRACT_AMOUNT, `amount must be at least ${MIN_CONTRACT_AMOUNT}`)
  .refine(
    (amount) => Number.isInteger(amount * STROOPS_PER_TOKEN),
    'amount supports at most 7 decimal places'
  )
  .max(MAX_CONTRACT_AMOUNT, `amount must not exceed ${MAX_CONTRACT_AMOUNT}`)

export const userIdParamSchema = z.object({
  userId: z.string().uuid('Invalid user ID format'),
})
