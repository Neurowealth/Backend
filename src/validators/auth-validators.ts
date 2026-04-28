import { z } from 'zod';

export const authChallengeSchema = z.object({
  stellarPubKey: z.string().trim().optional(),
});

export const authVerifySchema = z.object({
  stellarPubKey: z.string().trim().optional(),
  signature: z.string().trim().optional(),
});
