import { createMockDb } from '../../helpers/testDb'

const mockPrisma = createMockDb()

jest.mock('@prisma/client', () => {
  const actual = jest.requireActual('@prisma/client')
  return {
    ...actual,
    PrismaClient: jest.fn(() => mockPrisma),
  }
})

jest.mock('../../../src/stellar/client')
jest.mock('../../../src/utils/logger')

import * as stellarSdk from '@stellar/stellar-sdk'
import {
  retryDeadLetterEvents,
  startEventListener,
  stopEventListener,
} from '../../../src/stellar/events'
import { DeadLetterQueue } from '../../../src/stellar/dlq'
import { getRpcServer } from '../../../src/stellar/client'

const mockRpcServer = getRpcServer as jest.MockedFunction<typeof getRpcServer>

const CONTRACT_ID = 'CDUMMYVAULTCONTRACTID'
const WALLET = 'GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIBTICSQYY2T4YJJWUDLVXVVU6G'

function waitForPoll(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 100))
}

function makeDepositRpcEvent(ledger: number, txHash: string) {
  return {
    ledger,
    txHash,
    contractId: CONTRACT_ID,
    topic: [
      stellarSdk.nativeToScVal('deposit', { type: 'string' }),
      stellarSdk.nativeToScVal('USDC', { type: 'string' }),
      stellarSdk.nativeToScVal('blend', { type: 'string' }),
    ],
    value: stellarSdk.nativeToScVal({
      user: WALLET,
      amount: 1000n,
      shares: 100n,
    }),
  }
}

describe('Vault event recovery integration', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    stopEventListener()

    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      walletAddress: WALLET,
    })
    mockPrisma.transaction.upsert.mockResolvedValue({ id: 'tx-db-1' })
    mockPrisma.transaction.update.mockResolvedValue({
      id: 'tx-db-1',
      positionId: 'position-1',
    })
    mockPrisma.position.findFirst.mockResolvedValue(null)
    mockPrisma.position.create.mockResolvedValue({ id: 'position-1' })
    mockPrisma.position.update.mockResolvedValue({ id: 'position-1' })
    mockPrisma.processedEvent.findUnique.mockResolvedValue(null)
    mockPrisma.processedEvent.create.mockResolvedValue({ id: 'processed-1' })
    mockPrisma.eventCursor.upsert.mockResolvedValue({
      contractId: CONTRACT_ID,
      lastProcessedLedger: 102,
    })

    // DLQ-backed-by-Prisma needs an in-memory simulation of the rows it returns.
    let dlqRows: any[] = []
    mockPrisma.deadLetterEvent.create.mockImplementation(async (args: any) => {
      const row = {
        id: `dlq-${dlqRows.length + 1}`,
        ...args.data,
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      dlqRows.push(row)
      return row
    })
    mockPrisma.deadLetterEvent.findMany.mockImplementation(
      async (args: any) => {
        if (args?.where?.status?.in) {
          const allowed: string[] = args.where.status.in
          return dlqRows.filter((r) => allowed.includes(r.status))
        }
        return dlqRows
      }
    )
    mockPrisma.deadLetterEvent.count.mockImplementation(
      async () => dlqRows.length
    )
    mockPrisma.deadLetterEvent.update.mockImplementation(async (args: any) => {
      const row = dlqRows.find((r) => r.id === args.where.id)
      if (row) Object.assign(row, args.data, { updatedAt: new Date() })
      return row ?? { id: args.where.id }
    })
  })

  afterEach(() => {
    stopEventListener()
  })

  it('resumes from the stored cursor and advances it after replaying missed events', async () => {
    mockPrisma.eventCursor.findUnique.mockResolvedValue({
      contractId: CONTRACT_ID,
      lastProcessedLedger: 100,
    })

    const server = {
      getLatestLedger: jest.fn().mockResolvedValue({ sequence: 102 }),
      getEvents: jest.fn().mockResolvedValue({
        events: [makeDepositRpcEvent(101, 'tx_resume_101')],
      }),
    }
    mockRpcServer.mockReturnValue(server as any)

    await startEventListener()
    await waitForPoll()
    stopEventListener()

    expect(server.getEvents).toHaveBeenCalledWith(
      expect.objectContaining({ startLedger: 101 })
    )
    expect(mockPrisma.processedEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          txHash: 'tx_resume_101',
          ledger: 101,
        }),
      })
    )
    expect(mockPrisma.eventCursor.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ lastProcessedLedger: 102 }),
        create: expect.objectContaining({ lastProcessedLedger: 102 }),
      })
    )
  })

  it('retries pending DLQ events and marks them resolved after a successful replay', async () => {
    const eventPayload = {
      type: 'deposit' as const,
      ledger: 105,
      txHash: 'tx_dlq_retry_105',
      contractId: CONTRACT_ID,
      topics: [
        stellarSdk.nativeToScVal('deposit', { type: 'string' }),
        stellarSdk.nativeToScVal('USDC', { type: 'string' }),
        stellarSdk.nativeToScVal('blend', { type: 'string' }),
      ],
      value: stellarSdk.nativeToScVal({
        user: WALLET,
        amount: 2500n,
        shares: 250n,
      }),
    }

    await DeadLetterQueue.add(eventPayload, 'temporary downstream failure')

    await retryDeadLetterEvents()

    const queue = await DeadLetterQueue.getAll()
    expect(queue).toHaveLength(1)
    expect(queue[0].status).toBe('RESOLVED')
    expect(queue[0].retryCount).toBe(1)
    expect(mockPrisma.processedEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          txHash: 'tx_dlq_retry_105',
          ledger: 105,
        }),
      })
    )
  })
})
