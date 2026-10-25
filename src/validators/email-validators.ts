import { z } from 'zod'

/**
 * Email addresses are stored lowercased and trimmed so that
 * `User@Example.com` and `user@example.com ` can never become two distinct
 * identities. Normalisation lives here so every caller agrees on one form.
 */
export const emailAddressSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, 'Valid email address is required')
  .email('Valid email address is required')

export const requestEmailVerificationSchema = z.object({
  email: emailAddressSchema,
})

export const verifyEmailTokenSchema = z.object({
  token: z.string().trim().min(1, 'Verification token is required'),
})

export type RequestEmailVerificationInput = z.infer<
  typeof requestEmailVerificationSchema
>
