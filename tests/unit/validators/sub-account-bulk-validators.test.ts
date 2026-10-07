import {
  bulkSubAccountsSchema,
  bulkSubAccountOpSchema,
} from '../../../src/validators/sub-account-bulk-validators'

describe('sub-account-bulk-validators', () => {
  it('validates a correct bulk operations payload', () => {
    const valid = {
      atomic: true,
      operations: [
        {
          action: 'create',
          childUserId: '11111111-1111-4111-8111-111111111111',
          payload: {
            permissions: ['VIEW', 'DEPOSIT'],
            dailyLimit: 500,
          },
        },
        {
          action: 'setLimit',
          subAccountId: '22222222-2222-4222-8222-222222222222',
          payload: {
            dailyLimit: 1000,
          },
        },
      ],
    }

    const res = bulkSubAccountsSchema.safeParse(valid)
    expect(res.success).toBe(true)
  })

  it('fails if operations array is empty', () => {
    const invalid = {
      operations: [],
    }

    const res = bulkSubAccountsSchema.safeParse(invalid)
    expect(res.success).toBe(false)
  })

  it('validates individual operation schema', () => {
    const validOp = {
      action: 'revoke',
      subAccountId: '11111111-1111-4111-8111-111111111111',
    }

    const res = bulkSubAccountOpSchema.safeParse(validOp)
    expect(res.success).toBe(true)
  })
})
