// Lending request validation (#532).
//
// These schemas are the platform's outer boundary for a product that
// ultimately takes a user's collateral without asking. The tests are therefore
// about the values that must be REJECTED before any of that machinery is
// reached, plus the one coercion trap worth pinning: querystring booleans.

import {
  borrowingCapacityQuerySchema,
  listLoansQuerySchema,
  loanIdParamSchema,
  originateLoanSchema,
  positionIdParamSchema,
  repayLoanSchema,
} from '../../../src/validators/lending-validators'

describe('lending validators — params', () => {
  it('rejects a non-UUID loan id', () => {
    expect(
      loanIdParamSchema.safeParse({ loanId: '1; DROP TABLE' }).success
    ).toBe(false)
    expect(loanIdParamSchema.safeParse({ loanId: 'not-a-uuid' }).success).toBe(
      false
    )
  })

  it('accepts a UUID loan id', () => {
    const id = '0f2c1e6a-2b4d-4c8e-9a1f-7d3b5e9a0c11'
    expect(loanIdParamSchema.safeParse({ loanId: id }).success).toBe(true)
  })

  it('rejects a non-UUID position id', () => {
    expect(
      positionIdParamSchema.safeParse({ positionId: '../../etc/passwd' })
        .success
    ).toBe(false)
  })
})

describe('lending validators — originateLoanSchema', () => {
  const valid = {
    positionId: '0f2c1e6a-2b4d-4c8e-9a1f-7d3b5e9a0c11',
    amount: 500,
  }

  it('defaults the borrowed asset to USDC', () => {
    const parsed = originateLoanSchema.parse(valid)
    expect(parsed.assetSymbol).toBe('USDC')
  })

  it('upper-cases the asset symbol so "usdc" and "USDC" are one asset', () => {
    const parsed = originateLoanSchema.parse({ ...valid, assetSymbol: 'usdc' })
    expect(parsed.assetSymbol).toBe('USDC')
  })

  it('rejects an asset symbol with punctuation', () => {
    // The symbol is interpolated into memos and outbox payloads; a value with
    // separators in it is a lookup that silently matches nothing.
    expect(
      originateLoanSchema.safeParse({ ...valid, assetSymbol: 'USDC-PAY' })
        .success
    ).toBe(false)
    expect(
      originateLoanSchema.safeParse({ ...valid, assetSymbol: 'US DC' }).success
    ).toBe(false)
  })

  it('rejects a non-positive amount', () => {
    expect(originateLoanSchema.safeParse({ ...valid, amount: 0 }).success).toBe(
      false
    )
    expect(
      originateLoanSchema.safeParse({ ...valid, amount: -100 }).success
    ).toBe(false)
  })

  it('rejects an amount with more precision than settlement can represent', () => {
    // 7dp is the on-chain resolution. An 8dp loan would round somewhere
    // downstream and leave a permanently dust balance.
    expect(
      originateLoanSchema.safeParse({ ...valid, amount: 0.00000001 }).success
    ).toBe(false)
    expect(
      originateLoanSchema.safeParse({ ...valid, amount: 500.1234567 }).success
    ).toBe(true)
  })

  it('rejects Infinity and NaN outright', () => {
    expect(
      originateLoanSchema.safeParse({
        ...valid,
        amount: Number.POSITIVE_INFINITY,
      }).success
    ).toBe(false)
    expect(
      originateLoanSchema.safeParse({ ...valid, amount: Number.NaN }).success
    ).toBe(false)
  })

  it('rejects an over-long memo', () => {
    expect(
      originateLoanSchema.safeParse({ ...valid, memo: 'x'.repeat(281) }).success
    ).toBe(false)
    expect(
      originateLoanSchema.safeParse({ ...valid, memo: 'x'.repeat(280) }).success
    ).toBe(true)
  })

  it('requires a position id', () => {
    const { positionId, ...withoutPosition } = valid
    expect(originateLoanSchema.safeParse(withoutPosition).success).toBe(false)
  })
})

describe('lending validators — repayLoanSchema', () => {
  it('accepts an omitted amount as "settle the whole balance"', () => {
    // "Repay it all" is a button, not a flag; omitting the amount must mean
    // repay-in-full rather than fail validation.
    expect(repayLoanSchema.parse({}).amount).toBeUndefined()
  })

  it('rejects a negative repayment', () => {
    // A negative amount is a withdrawal wearing a repayment's clothes, and it
    // would be a way to extract a loan's proceeds back out of the platform.
    expect(repayLoanSchema.safeParse({ amount: -1 }).success).toBe(false)
  })
})

describe('lending validators — listLoansQuerySchema', () => {
  it('coerces the string "false" to boolean false', () => {
    // The trap this guards: with a bare boolean + default, ?includeClosed=false
    // would be rejected, and a client that stripped the value would silently
    // get the opposite of what it asked for.
    expect(
      listLoansQuerySchema.parse({ includeClosed: 'false' }).includeClosed
    ).toBe(false)
    expect(
      listLoansQuerySchema.parse({ includeClosed: 'true' }).includeClosed
    ).toBe(true)
  })

  it('leaves an absent flag undefined rather than defaulting it to a guess', () => {
    expect(listLoansQuerySchema.parse({}).includeClosed).toBeUndefined()
  })

  it('rejects a value that is neither true nor false', () => {
    expect(
      listLoansQuerySchema.safeParse({ includeClosed: 'yes' }).success
    ).toBe(false)
    expect(listLoansQuerySchema.safeParse({ includeClosed: '1' }).success).toBe(
      false
    )
  })
})

describe('lending validators — borrowingCapacityQuerySchema', () => {
  it('requires a UUID position', () => {
    expect(
      borrowingCapacityQuerySchema.safeParse({
        positionId: '0f2c1e6a-2b4d-4c8e-9a1f-7d3b5e9a0c11',
      }).success
    ).toBe(true)
    expect(
      borrowingCapacityQuerySchema.safeParse({ positionId: 'abc' }).success
    ).toBe(false)
    expect(borrowingCapacityQuerySchema.safeParse({}).success).toBe(false)
  })
})
