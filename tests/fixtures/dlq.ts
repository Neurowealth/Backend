export const FIXTURE_DLQ_PENDING = {
  id: 'dlq-0001-0001-0001-000000000001',
  contractId: 'contract-fixture-1',
  txHash: 'tx-fixture-abc123',
  eventType: 'deposit',
  ledger: 100,
  error: 'processing failed: timeout',
  payload: {},
  status: 'PENDING' as const,
  retryCount: 0,
  createdAt: new Date('2024-01-01T00:00:00Z'),
  updatedAt: new Date('2024-01-01T00:00:00Z'),
}

export const FIXTURE_DLQ_RETRIED = {
  id: 'dlq-0002-0002-0002-000000000002',
  contractId: 'contract-fixture-2',
  txHash: 'tx-fixture-def456',
  eventType: 'withdrawal',
  ledger: 101,
  error: 'processing failed: network error',
  payload: {},
  status: 'RETRIED' as const,
  retryCount: 2,
  createdAt: new Date('2024-01-01T01:00:00Z'),
  updatedAt: new Date('2024-01-01T02:00:00Z'),
}

export const FIXTURE_DLQ_RESOLVED = {
  id: 'dlq-0003-0003-0003-000000000003',
  contractId: 'contract-fixture-3',
  txHash: 'tx-fixture-ghi789',
  eventType: 'yield_claim',
  ledger: 102,
  error: 'processing failed: bad payload',
  payload: {},
  status: 'RESOLVED' as const,
  retryCount: 1,
  createdAt: new Date('2024-01-01T02:00:00Z'),
  updatedAt: new Date('2024-01-01T03:00:00Z'),
}

export function makeDlqEntry(
  overrides: Partial<typeof FIXTURE_DLQ_PENDING> = {}
) {
  return { ...FIXTURE_DLQ_PENDING, ...overrides }
}
