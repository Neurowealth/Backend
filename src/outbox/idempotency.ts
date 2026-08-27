import { OutboxOpKind } from './types'

/**
 * Deterministic idempotency anchor for an outbox op: `kind:userId:businessRecordId`.
 *
 * businessRecordId is whatever row this op is the durable intent for — a
 * Transaction id for DEPOSIT/WITHDRAW/REBALANCE, a ReferralConversion leg for
 * REFERRAL_REWARD. Reusing the SAME businessRecordId (e.g. retrying against an
 * already-PENDING Transaction) resolves to the same key, so
 * src/outbox/service.ts's upsert-by-key never creates a second op for work
 * that is already durably queued.
 */
export function deriveIdempotencyKey(
  kind: OutboxOpKind,
  userId: string,
  businessRecordId: string
): string {
  if (!userId) throw new Error('deriveIdempotencyKey: userId is required')
  if (!businessRecordId) {
    throw new Error('deriveIdempotencyKey: businessRecordId is required')
  }
  return `${kind}:${userId}:${businessRecordId}`
}
