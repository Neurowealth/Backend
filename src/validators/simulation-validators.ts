import { z } from 'zod'

export const simulateGoalBodySchema = z.object({
  iterations: z
    .number()
    .int()
    .min(10, 'At least 10 iterations required')
    .max(10000, 'Maximum 10,000 iterations')
    .optional()
    .default(1000),
  seed: z.number().int().min(0).max(2147483647).optional(),
  mode: z.enum(['bootstrap', 'parametric']).optional().default('bootstrap'),
})

export const simulateGoalSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid goal ID format'),
  }),
  body: simulateGoalBodySchema,
})

export const simulateBacktestSchema = z.object({
  query: z.object({
    simulate: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
    iterations: z
      .string()
      .transform((v) => parseInt(v, 10))
      .pipe(z.number().int().min(10).max(10000))
      .optional(),
    seed: z
      .string()
      .transform((v) => parseInt(v, 10))
      .pipe(z.number().int().min(0).max(2147483647))
      .optional(),
  }),
})
