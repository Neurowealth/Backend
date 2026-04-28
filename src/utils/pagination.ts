import { z } from 'zod'

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(5),
})

export function getPaginationParams(query: any) {
  const page = Number(query.page) || 1
  const limit = Number(query.limit) || 5
  const skip = (page - 1) * limit
  return { page, limit, skip }
}
