/**
 * E2E tests for the Stellar event listener processing pipeline (Issue #98).
 *
 * Uses mocked RPC + in-memory Prisma to verify ingestion, deduplication,
 * DB side effects, and DLQ retry semantics without external network calls.
 */
import { createMockDb } from '../../helpers/testDb'
import {
  buildDepositEvent,
  buildDepositRpcEvent,
  HARNESS_CONTRACT_ID,
  HARNESS_WALLET,
  wireInMemoryDlq,
  wireInMemoryProcessedEvents,
} from '../../helpers/stellarEventHarness'

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

import {
  handleEvent,
  processEventBatch,
  retryDeadLetterEvents,
  startEventListener,
  stopEventListener,
} from '../../../src/stellar/events'
import { DeadLetterQueue } from '../../../src/stellar/dlq'
import { getRpcServer } from '../../../src/stellar/client'

const mockRpcServer = getRpcServer as jest.MockedFunction<typeof getRpcServer>

function waitForPoll(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 100))
}

function seedHappyPathMocks(): void {
  mockPrisma.user.findUnique.mockResolvedValue({
    id: 'user-e2e-1',
    walletAddress: HARNESS_WALLET,
  })
  mockPrisma.transaction.upsert.mockResolvedValue({ id: 'tx-db-e2e-1' })
  mockPrisma.transaction.update.mockResolvedValue({
    id: 'tx-db-e2e-1',
    positionId: 'position-e2e-1',
  })
  mockPrisma.position.findFirst.mockResolvedValue(null)
  mockPrisma.position.create.mockResolvedValue({ id: 'position-e2e-1' })
  mockPrisma.position.update.mockResolvedValue({ id: 'position-e2e-1' })
  mockPrisma.$transaction.mockImplementation(async (cb: (tx: typeof mockPrisma) => Promise<void>) =>
    cb(mockPrisma)
  )
}

describe('Event listener E2E pipeline (Issue #98)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    stopEventListener()
    seedHappyPathMocks()
    wireInMemoryProcessedEvents(mockPrisma)
    wireInMemoryDlq(mockPrisma)
  })

  afterEach(() => {
    stopEventListener()
  })

  describe('normal processing', () => {
    it('consumes a deposit event and updates transactions and processed_events', async () => {
      const event = buildDepositEvent({
        ledger: 200,
        txHash: 'tx_e2e_normal_200',
      })

      await handleEvent(event, mockPrisma)

      expect(mockPrisma.transaction.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { txHash: 'tx_e2e_normal_200' },
          create: expect.objectContaining({
            type: 'DEPOSIT',
            status: 'CONFIRMED',
          }),
        })
      )
      expect(mockPrisma.processedEvent.create).toHaveBeenCalledTimes(1)
      expect(mockPrisma.processedEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            txHash: 'tx_e2e_normal_200',
            eventType: 'deposit',
            ledger: 200,
          }),
        })
      )
    })

    it('ingests RPC events via the listener poll loop and advances the cursor', async () => {
      mockPrisma.eventCursor.findUnique.mockResolvedValue({
        contractId: HARNESS_CONTRACT_ID,
        lastProcessedLedger: 300,
      })
      mockPrisma.eventCursor.upsert.mockResolvedValue({
        contractId: HARNESS_CONTRACT_ID,
        lastProcessedLedger: 302,
      })

      const server = {
        getLatestLedger: jest.fn().mockResolvedValue({ sequence: 302 }),
        getEvents: jest.fn().mockResolvedValue({
          events: [buildDepositRpcEvent(301, 'tx_e2e_listener_301')],
        }),
      }
      mockRpcServer.mockReturnValue(server as never)

      await startEventListener()
      await waitForPoll()
      stopEventListener()

      expect(server.getEvents).toHaveBeenCalledWith(
        expect.objectContaining({ startLedger: 301 })
      )
      expect(mockPrisma.processedEvent.create).toHaveBeenCalled()
      expect(mockPrisma.eventCursor.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({ lastProcessedLedger: 302 }),
        })
      )
    })

    it('processes a batch in a single transaction', async () => {
      const events = [
        buildDepositEvent({ ledger: 401, txHash: 'tx_batch_a' }),
        buildDepositEvent({ ledger: 402, txHash: 'tx_batch_b' }),
      ]

      await processEventBatch(events)

      expect(mockPrisma.$transaction).toHaveBeenCalled()
      expect(mockPrisma.processedEvent.create).toHaveBeenCalledTimes(2)
    })
  })

  describe('deduplication', () => {
    it('does not double-process the same tx hash and ledger', async () => {
      const event = buildDepositEvent({
        ledger: 500,
        txHash: 'tx_e2e_dedup_500',
      })

      await handleEvent(event, mockPrisma)
      await handleEvent(event, mockPrisma)

      expect(mockPrisma.transaction.upsert).toHaveBeenCalledTimes(1)
      expect(mockPrisma.processedEvent.create).toHaveBeenCalledTimes(1)
    })
  })

  describe('failure path and DLQ', () => {
    it('moves a failed event to the DLQ and resolves it on retry', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null)

      const event = buildDepositEvent({
        ledger: 600,
        txHash: 'tx_e2e_dlq_600',
      })

      await expect(handleEvent(event, mockPrisma)).rejects.toThrow()

      const queueAfterFailure = await DeadLetterQueue.getAll()
      expect(queueAfterFailure).toHaveLength(1)
      expect(queueAfterFailure[0].status).toBe('PENDING')
      expect(queueAfterFailure[0].txHash).toBe('tx_e2e_dlq_600')

      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-e2e-1',
        walletAddress: HARNESS_WALLET,
      })

      await retryDeadLetterEvents()

      const queueAfterRetry = await DeadLetterQueue.getAll()
      expect(queueAfterRetry[0].status).toBe('RESOLVED')
      expect(queueAfterRetry[0].retryCount).toBe(1)
      expect(mockPrisma.processedEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ txHash: 'tx_e2e_dlq_600' }),
        })
      )
    })
  })
})
