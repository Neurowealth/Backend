/**
 * Test harness for injecting mocked Stellar contract events into the
 * event-processing pipeline without a live RPC (Issue #98).
 */
import * as stellarSdk from '@stellar/stellar-sdk'
import type { ContractEvent } from '../../src/stellar/types'

export const HARNESS_CONTRACT_ID = 'CDUMMYVAULTCONTRACTID'
export const HARNESS_WALLET =
  'GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIBTICSQYY2T4YJJWUDLVXVVU6G'

export interface BuildDepositOptions {
  ledger?: number
  txHash?: string
  amount?: bigint
  shares?: bigint
  assetSymbol?: string
  protocolName?: string
}

/** Build a valid deposit ContractEvent with required topics. */
export function buildDepositEvent(
  options: BuildDepositOptions = {}
): ContractEvent {
  const {
    ledger = 100,
    txHash = `tx_deposit_${ledger}`,
    amount = 1000n,
    shares = 100n,
    assetSymbol = 'USDC',
    protocolName = 'blend',
  } = options

  return {
    type: 'deposit',
    ledger,
    txHash,
    contractId: HARNESS_CONTRACT_ID,
    topics: [
      stellarSdk.nativeToScVal('deposit', { type: 'string' }),
      stellarSdk.nativeToScVal(assetSymbol, { type: 'string' }),
      stellarSdk.nativeToScVal(protocolName, { type: 'string' }),
    ],
    value: stellarSdk.nativeToScVal({
      user: HARNESS_WALLET,
      amount,
      shares,
    }),
  }
}

/** RPC-shaped event payload returned by a mocked getEvents(). */
export function buildDepositRpcEvent(ledger: number, txHash: string) {
  const event = buildDepositEvent({ ledger, txHash })
  return {
    ledger: event.ledger,
    txHash: event.txHash,
    contractId: event.contractId,
    topic: event.topics,
    value: event.value,
  }
}

/** In-memory DLQ simulation backed by mockPrisma.deadLetterEvent.* */
export function wireInMemoryDlq(mockPrisma: {
  deadLetterEvent: {
    create: jest.Mock
    findMany: jest.Mock
    count: jest.Mock
    update: jest.Mock
  }
}): { rows: Array<Record<string, unknown>> } {
  const store = { rows: [] as Array<Record<string, unknown>> }

  mockPrisma.deadLetterEvent.create.mockImplementation(async (args: { data: unknown }) => {
    const row = {
      id: `dlq-${store.rows.length + 1}`,
      ...(args.data as Record<string, unknown>),
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    store.rows.push(row)
    return row
  })

  mockPrisma.deadLetterEvent.findMany.mockImplementation(
    async (args?: { where?: { status?: { in?: string[] } } }) => {
      const allowed = args?.where?.status?.in
      if (!allowed) return [...store.rows]
      return store.rows.filter((r) => allowed.includes(String(r.status)))
    }
  )

  mockPrisma.deadLetterEvent.count.mockImplementation(async () => store.rows.length)

  mockPrisma.deadLetterEvent.update.mockImplementation(
    async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = store.rows.find((r) => r.id === args.where.id)
      if (row) Object.assign(row, args.data, { updatedAt: new Date() })
      return row ?? { id: args.where.id }
    }
  )

  return store
}

/** In-memory processed_events store for deduplication assertions. */
export function wireInMemoryProcessedEvents(mockPrisma: {
  processedEvent: {
    findUnique: jest.Mock
    create: jest.Mock
  }
}): { keys: Set<string> } {
  const store = { keys: new Set<string>() }

  const compositeKey = (data: {
    contractId: string
    txHash: string
    eventType: string
    ledger: number
  }) => `${data.contractId}:${data.txHash}:${data.eventType}:${data.ledger}`

  mockPrisma.processedEvent.findUnique.mockImplementation(async (args: any) => {
    const keyParts = args.where.contractId_txHash_eventType_ledger
    const k = compositeKey(keyParts)
    if (!store.keys.has(k)) return null
    return { id: 'processed-existing', ...keyParts }
  })

  mockPrisma.processedEvent.create.mockImplementation(
    async ({ data }: { data: { contractId: string; txHash: string; eventType: string; ledger: number } }) => {
      store.keys.add(compositeKey(data))
      return { id: `processed-${store.keys.size}`, ...data }
    }
  )

  return store
}
