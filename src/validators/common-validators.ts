import { z } from 'zod';

export const userIdParamSchema = z.object({
  userId: z.string().uuid('Invalid user ID format'),
});
