import { deriveIdempotencyKey } from '../../../src/outbox/idempotency'

describe('src/outbox/idempotency', () => {
  it('derives a deterministic kind:userId:businessRecordId key', () => {
    expect(deriveIdempotencyKey('DEPOSIT', 'user-1', 'txn-1')).toBe(
      'DEPOSIT:user-1:txn-1'
    )
  })

  it('is deterministic — the same inputs always produce the same key', () => {
    const a = deriveIdempotencyKey('WITHDRAW', 'user-2', 'txn-2')
    const b = deriveIdempotencyKey('WITHDRAW', 'user-2', 'txn-2')
    expect(a).toBe(b)
  })

  it('different kinds for the same record never collide', () => {
    const deposit = deriveIdempotencyKey('DEPOSIT', 'user-1', 'record-1')
    const withdraw = deriveIdempotencyKey('WITHDRAW', 'user-1', 'record-1')
    expect(deposit).not.toBe(withdraw)
  })

  it('different users for the same record never collide', () => {
    const a = deriveIdempotencyKey('REFERRAL_REWARD', 'user-a', 'conv:owner')
    const b = deriveIdempotencyKey('REFERRAL_REWARD', 'user-b', 'conv:owner')
    expect(a).not.toBe(b)
  })

  it('throws without a userId', () => {
    expect(() => deriveIdempotencyKey('DEPOSIT', '', 'record-1')).toThrow()
  })

  it('throws without a businessRecordId', () => {
    expect(() => deriveIdempotencyKey('DEPOSIT', 'user-1', '')).toThrow()
  })
})
