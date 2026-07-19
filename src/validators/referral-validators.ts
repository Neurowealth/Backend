import { z } from 'zod'

/** Route param schema for owner-scoped referral endpoints. */
export const referralUserParamsSchema = z.object({
  userId: z.string().trim().min(1, 'userId is required'),
})
