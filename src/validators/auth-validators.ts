import { z } from 'zod';

export const authChallengeSchema = z.object({
  stellarPubKey: z.string().trim().min(56).max(56).regex(/^G[A-Z2-7]{55}$/, 'Invalid Stellar public key format'),
});

export const authVerifySchema = z.object({
  stellarPubKey: z.string().trim().min(56).max(56).regex(/^G[A-Z2-7]{55}$/, 'Invalid Stellar public key format'),
  signature: z.string().trim().min(1),
});
