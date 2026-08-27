import {
  validateFilterPredicate,
  evaluateFilterPredicate,
  FilterCondition,
} from '../../../src/utils/userWebhookFilter'

describe('userWebhookFilter (#368)', () => {
  it('validates filter predicate grammar correctly', () => {
    expect(
      validateFilterPredicate({
        field: 'amount',
        op: 'gt' as const,
        value: 100,
      })
    ).toBe(true)
    expect(
      validateFilterPredicate({
        field: 'type',
        op: 'eq' as const,
        value: 'WITHDRAWAL',
      })
    ).toBe(true)
    expect(
      validateFilterPredicate({
        and: [
          { field: 'amount', op: 'gt' as const, value: 100 },
          { field: 'type', op: 'eq' as const, value: 'WITHDRAWAL' },
        ],
      })
    ).toBe(true)
  })

  it('rejects invalid filter predicate grammar', () => {
    expect(() => validateFilterPredicate(null)).toThrow()
    expect(() =>
      validateFilterPredicate({ field: '', op: 'eq' as const, value: 10 })
    ).toThrow()
    expect(() =>
      validateFilterPredicate({
        field: 'amount',
        op: 'invalid_op' as any,
        value: 10,
      })
    ).toThrow()
    expect(() =>
      validateFilterPredicate({
        field: 'type',
        op: 'in' as const,
        value: 'not_an_array',
      })
    ).toThrow()
  })

  it('evaluates eq, gt, lt, in operators accurately', () => {
    const payload = {
      type: 'WITHDRAWAL',
      amount: 250,
      status: 'CONFIRMED',
      tags: ['urgent', 'crypto'],
    }

    expect(
      evaluateFilterPredicate(
        { field: 'type', op: 'eq' as const, value: 'WITHDRAWAL' },
        payload
      )
    ).toBe(true)
    expect(
      evaluateFilterPredicate(
        { field: 'type', op: 'eq' as const, value: 'DEPOSIT' },
        payload
      )
    ).toBe(false)

    expect(
      evaluateFilterPredicate(
        { field: 'amount', op: 'gt' as const, value: 200 },
        payload
      )
    ).toBe(true)
    expect(
      evaluateFilterPredicate(
        { field: 'amount', op: 'gt' as const, value: 300 },
        payload
      )
    ).toBe(false)

    expect(
      evaluateFilterPredicate(
        { field: 'amount', op: 'lt' as const, value: 300 },
        payload
      )
    ).toBe(true)
    expect(
      evaluateFilterPredicate(
        { field: 'amount', op: 'lt' as const, value: 100 },
        payload
      )
    ).toBe(false)

    expect(
      evaluateFilterPredicate(
        { field: 'status', op: 'in' as const, value: ['CONFIRMED', 'PENDING'] },
        payload
      )
    ).toBe(true)
    expect(
      evaluateFilterPredicate(
        { field: 'status', op: 'in' as const, value: ['FAILED'] },
        payload
      )
    ).toBe(false)
  })

  it('evaluates nested AND and OR predicates', () => {
    const payload = { amount: 500, type: 'WITHDRAWAL' }

    const andPredicate: FilterCondition = {
      and: [
        { field: 'amount', op: 'gt' as const, value: 100 },
        { field: 'type', op: 'eq' as const, value: 'WITHDRAWAL' },
      ],
    }

    const orPredicate: FilterCondition = {
      or: [
        { field: 'type', op: 'eq' as const, value: 'DEPOSIT' },
        { field: 'amount', op: 'gt' as const, value: 400 },
      ],
    }

    expect(evaluateFilterPredicate(andPredicate, payload)).toBe(true)
    expect(evaluateFilterPredicate(orPredicate, payload)).toBe(true)
  })
})
