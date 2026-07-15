import db from '../db'

export type TransactionEventType =
  | 'INITIATED'
  | 'SUBMITTED'
  | 'CONFIRMED'
  | 'FAILED'
  | 'RETRIED'
  | 'REVERSED'

export async function recordTransactionEvent(
  transactionId: string,
  event: TransactionEventType,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await (db as any).transactionEvent.create({
    data: {
      transactionId,
      event,
      metadata: metadata ?? undefined,
    },
  })
}