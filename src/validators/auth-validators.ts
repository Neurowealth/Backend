import { z } from 'zod'

export const authChallengeSchema = z.object({
  stellarPubKey: z.string().trim().min(1, 'stellarPubKey is required'),
})

export const authVerifySchema = z.object({
  stellarPubKey: z.string().trim().min(1, 'stellarPubKey is required'),
  signature: z.string().trim().min(1, 'signature is required'),
  // Optional referral code, captured at signup for attribution. Only applied
  // when this call creates a brand-new user. Invalid/self/duplicate codes are
  // ignored rather than failing the signup.
  referralCode: z.string().trim().max(32).optional(),
})

// #472: the refresh token is 48 random bytes base64url-encoded (64 chars).
// Bounding the length keeps an attacker from submitting a megabyte of string
// that still costs a bcrypt compare downstream.
export const authRefreshSchema = z.object({
  refreshToken: z
    .string({ error: 'refreshToken is required' })
    .trim()
    .min(1, 'refreshToken is required')
    .max(256, 'refreshToken is not a valid token'),
})
