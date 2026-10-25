import {
  buildPaginationMeta,
  getPaginationParams,
  paginationSchema,
} from '../../../src/utils/pagination'

describe('pagination helpers', () => {
  it('uses bounded defaults and computes an offset', () => {
    expect(getPaginationParams({})).toEqual({ page: 1, limit: 20, skip: 0 })
    expect(getPaginationParams({ page: '3', limit: '25' })).toEqual({
      page: 3,
      limit: 25,
      skip: 50,
    })
  })

  it('rejects out-of-range pagination requests', () => {
    expect(paginationSchema.safeParse({ page: '0' }).success).toBe(false)
    expect(paginationSchema.safeParse({ limit: '51' }).success).toBe(false)
  })

  it('returns stable metadata for empty and populated pages', () => {
    expect(buildPaginationMeta(1, 20, 0)).toEqual({
      page: 1,
      limit: 20,
      total: 0,
      totalPages: 0,
      hasNext: false,
      hasPrevious: false,
    })
    expect(buildPaginationMeta(2, 10, 25)).toEqual({
      page: 2,
      limit: 10,
      total: 25,
      totalPages: 3,
      hasNext: true,
      hasPrevious: true,
    })
  })
})
