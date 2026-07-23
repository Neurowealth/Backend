export const FIXTURE_PROCESSED_EVENT_1 = {
  id: 'evt-0001-0001-0001-000000000001',
  contractId: 'CCONTRACT1111111111111111111111111111111111111111111111111',
  txHash: 'txhash-fixture-event-1-abcdef1234567890abcdef1234567890',
  eventType: 'deposit',
  ledger: 1000,
  processedAt: new Date('2024-01-01T00:00:00Z'),
}

export const FIXTURE_PROCESSED_EVENT_2 = {
  id: 'evt-0002-0002-0002-000000000002',
  contractId: 'CCONTRACT1111111111111111111111111111111111111111111111111',
  txHash: 'txhash-fixture-event-2-abcdef1234567890abcdef1234567890',
  eventType: 'withdrawal',
  ledger: 1001,
  processedAt: new Date('2024-01-01T01:00:00Z'),
}

export function makeProcessedEvent(
  overrides: Partial<typeof FIXTURE_PROCESSED_EVENT_1> = {}
) {
  return { ...FIXTURE_PROCESSED_EVENT_1, ...overrides }
}
