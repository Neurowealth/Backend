import { rpc, scValToNative, xdr } from '@stellar/stellar-sdk'
import { TransactionType, TransactionStatus, Network } from '@prisma/client'
import db from '../db'
import { Decimal } from '@prisma/client/runtime/library'
import { getResilientClient } from './client'
import {
  ContractEvent,
  DepositEvent,
  WithdrawEvent,
  RebalanceEvent,
  EventMetrics,
} from './types'
import { logger } from '../utils/logger'
import { config } from '../config'
import { DeadLetterQueue } from './dlq'
import {
  generateCorrelationId,
  runWithCorrelationIdAsync,
} from '../utils/correlation'
import {
  ContractEventSchema,
  DepositEventSchema,
  WithdrawEventSchema,
  RebalanceEventSchema,
} from '../validators/event-validator'
import {
  recordEventProcessed,
  recordEventFailed,
  recordEventDuration,
  updateDlqSize,
  updateCursorLag,
  updateLastProcessedLedger,
  recordDbOperation,
} from '../utils/metrics'
import { publishUserEvent } from '../events/publisher'
import { EVENT_TYPE_TOPIC } from '../events/types'
import { checkAndActivateOnDeposit } from '../referral/service'
import { reconcileOutboxOpByTxHash } from '../outbox/service'
import {
  createLotForDeposit,
  recordDisposalsForWithdrawal,
} from '../tax/service'

const VAULT_CONTRACT_ID = config.stellar.vaultContractId
const POLL_INTERVAL_MS = 5000

let lastProcessedLedger = 0
let isListening = false

// --- Metrics state (Issue #50) ---
const metrics: EventMetrics = {
  totalProcessed: 0,
  totalErrors: 0,
  processingRatePerMinute: 0,
  errorRate: 0,
  ledgerLag: 0,
  lastDbOperationMs: 0,
  lastUpdated: new Date(),
}

// Rolling window for processing rate (events in last 60s)
const processingTimestamps: number[] = []

function recordProcessed(): void {
  const now = Date.now()
  processingTimestamps.push(now)
  // Keep only last 60 seconds
  const cutoff = now - 60_000
  while (processingTimestamps.length > 0 && processingTimestamps[0] < cutoff) {
    processingTimestamps.shift()
  }
  metrics.totalProcessed++
  metrics.processingRatePerMinute = processingTimestamps.length
  metrics.errorRate =
    metrics.totalProcessed > 0
      ? metrics.totalErrors / metrics.totalProcessed
      : 0
  metrics.lastUpdated = new Date()
}

function recordError(): void {
  metrics.totalErrors++
  metrics.errorRate =
    metrics.totalProcessed > 0
      ? metrics.totalErrors / metrics.totalProcessed
      : 0
  metrics.lastUpdated = new Date()
}

function recordLedgerLag(latestLedger: number): void {
  metrics.ledgerLag = latestLedger - lastProcessedLedger
  metrics.lastUpdated = new Date()
  // Update Prometheus metrics
  updateCursorLag(metrics.ledgerLag)
}

async function timedDbOperation<T>(fn: () => Promise<T>): Promise<T> {
  const start = Date.now()
  try {
    return await fn()
  } finally {
    const duration = Date.now() - start
    metrics.lastDbOperationMs = duration
    metrics.lastUpdated = new Date()
    // Record Prometheus metric for DB operation duration
    recordDbOperation('event_processing', duration / 1000)
  }
}

/**
 * Get current event processing metrics (Issue #50)
 */
export function getEventMetrics(): Readonly<EventMetrics> {
  return { ...metrics }
}

// --- Event context extraction helpers (Issues #51, #65) ---

/**
 * Read a string topic at the given index. Throws when the topic is
 * missing or doesn't decode to a non-empty string — #65 explicitly
 * removes the previous USDC/vault fallbacks so malformed events flow
 * through to the DLQ instead of silently being persisted as USDC.
 */
function readStringTopic(
  event: ContractEvent,
  index: number,
  label: string
): string {
  if (event.topics.length <= index) {
    throw new Error(
      `[Event] Missing ${label} topic at index ${index} (txHash=${event.txHash}, type=${event.type})`
    )
  }
  let raw: unknown
  try {
    raw = scValToNative(event.topics[index])
  } catch (err) {
    throw new Error(
      `[Event] Failed to decode ${label} topic at index ${index} (txHash=${event.txHash}): ${
        err instanceof Error ? err.message : 'unknown decode error'
      }`
    )
  }
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(
      `[Event] ${label} topic at index ${index} is not a non-empty string (txHash=${event.txHash}, got=${typeof raw})`
    )
  }
  return raw
}

/**
 * Extract asset symbol from event topics. Topic[1] carries the asset.
 * Throws when missing — see {@link readStringTopic}.
 */
export function extractAssetSymbol(event: ContractEvent): string {
  return readStringTopic(event, 1, 'asset symbol')
}

/**
 * Extract protocol name from event topics. Topic[2] carries the protocol.
 * Throws when missing — see {@link readStringTopic}.
 */
export function extractProtocolName(event: ContractEvent): string {
  return readStringTopic(event, 2, 'protocol name')
}

/**
 * Extract network from config (canonical source of truth).
 */
function extractNetwork(): Network {
  switch (config.stellar.network) {
    case 'testnet':
      return Network.TESTNET
    case 'futurenet':
      return Network.FUTURENET
    case 'mainnet':
      return Network.MAINNET
  }
}

/**
 * Parse deposit event
 */
function parseDepositEvent(event: ContractEvent): DepositEvent {
  const data = scValToNative(event.value)
  return {
    user: data.user,
    amount: data.amount?.toString() || '0',
    shares: data.shares?.toString() || '0',
    assetSymbol: extractAssetSymbol(event),
    protocolName: extractProtocolName(event),
    network: extractNetwork(),
  }
}

/**
 * Parse withdraw event
 */
function parseWithdrawEvent(event: ContractEvent): WithdrawEvent {
  const data = scValToNative(event.value)
  return {
    user: data.user,
    amount: data.amount?.toString() || '0',
    shares: data.shares?.toString() || '0',
    assetSymbol: extractAssetSymbol(event),
    protocolName: extractProtocolName(event),
    network: extractNetwork(),
  }
}

/**
 * Parse rebalance event
 */
function parseRebalanceEvent(event: ContractEvent): RebalanceEvent {
  const data = scValToNative(event.value)
  return {
    protocol: data.protocol,
    apy: data.apy / 100, // Convert basis points to percentage
    timestamp: data.timestamp,
    assetSymbol: extractAssetSymbol(event),
    network: extractNetwork(),
  }
}

/**
 * Handle deposit event - persist to database
 */
async function handleDepositEvent(
  depositData: DepositEvent,
  event: ContractEvent,
  tx: any = db
): Promise<string> {
  const user = (await timedDbOperation(() =>
    tx.user.findUnique({ where: { walletAddress: depositData.user } })
  )) as any

  if (!user) {
    logger.warn(`[Deposit] User not found for wallet: ${depositData.user}`)
    throw new Error(`[Deposit] User not found for wallet: ${depositData.user}`)
  }

  const transaction = (await timedDbOperation(() =>
    tx.transaction.upsert({
      where: { txHash: event.txHash },
      update: { status: TransactionStatus.CONFIRMED, confirmedAt: new Date() },
      create: {
        userId: user.id,
        txHash: event.txHash,
        type: TransactionType.DEPOSIT,
        status: TransactionStatus.CONFIRMED,
        assetSymbol: depositData.assetSymbol,
        amount: depositData.amount,
        network: depositData.network,
        confirmedAt: new Date(),
      },
    })
  )) as any

  // #325 confirmation fallback: closes out a SUBMITTED OutboxOp left behind
  // by a dispatcher crash between submission and its own confirmation. No-op
  // for txHashes with no matching op.
  await reconcileOutboxOpByTxHash(tx, event.txHash)

  const position = (await timedDbOperation(() =>
    tx.position.findFirst({
      where: {
        userId: user.id,
        protocolName: depositData.protocolName,
        assetSymbol: depositData.assetSymbol,
        status: 'ACTIVE',
      },
    })
  )) as any

  if (position) {
    await timedDbOperation(() =>
      tx.position.update({
        where: { id: position.id },
        data: {
          depositedAmount: { increment: depositData.amount },
          currentValue: { increment: depositData.amount },
          updatedAt: new Date(),
        },
      })
    )
    await timedDbOperation(() =>
      tx.transaction.update({
        where: { id: transaction.id },
        data: { positionId: position.id },
      })
    )
  } else {
    const newPosition = (await timedDbOperation(() =>
      tx.position.create({
        data: {
          userId: user.id,
          protocolName: depositData.protocolName,
          assetSymbol: depositData.assetSymbol,
          depositedAmount: depositData.amount,
          currentValue: depositData.amount,
          yieldEarned: 0,
        },
      })
    )) as any
    await timedDbOperation(() =>
      tx.transaction.update({
        where: { id: transaction.id },
        data: { positionId: newPosition.id },
      })
    )
  }

  // Referral activation: verified strictly against this real, confirmed deposit
  // Transaction — never a client claim. Runs on the same `tx` handle so it is
  // part of the deposit's DB transaction. It never throws (a referral problem
  // must not roll back the deposit). Payout happens later in the payout job.
  await checkAndActivateOnDeposit(
    user.id,
    transaction.id,
    depositData.amount,
    tx
  )

  // Tax cost-basis lot (#284): one lot per confirmed deposit Transaction,
  // created on the same `tx` handle so it is part of the deposit's DB
  // transaction. Never throws (a tax-bookkeeping problem must not roll back
  // the deposit) — failures log + alert and are backfillable.
  await createLotForDeposit(
    user.id,
    transaction.id,
    depositData.assetSymbol,
    depositData.amount,
    transaction.confirmedAt ?? new Date(),
    tx
  )

  // Returned so handleEvent can address the real-time stream to the right
  // user without repeating the walletAddress lookup this function already did.
  return user.id
}

/**
 * Handle withdraw event - persist to database
 */
async function handleWithdrawEvent(
  withdrawData: WithdrawEvent,
  event: ContractEvent,
  tx: any = db
): Promise<string> {
  const user = (await timedDbOperation(() =>
    tx.user.findUnique({ where: { walletAddress: withdrawData.user } })
  )) as any

  if (!user) {
    logger.warn(`[Withdraw] User not found for wallet: ${withdrawData.user}`)
    throw new Error(
      `[Withdraw] User not found for wallet: ${withdrawData.user}`
    )
  }

  const transaction = (await timedDbOperation(() =>
    tx.transaction.upsert({
      where: { txHash: event.txHash },
      update: { status: TransactionStatus.CONFIRMED, confirmedAt: new Date() },
      create: {
        userId: user.id,
        txHash: event.txHash,
        type: TransactionType.WITHDRAWAL,
        status: TransactionStatus.CONFIRMED,
        assetSymbol: withdrawData.assetSymbol,
        amount: withdrawData.amount,
        network: withdrawData.network,
        confirmedAt: new Date(),
      },
    })
  )) as any

  // #325 confirmation fallback: closes out a SUBMITTED OutboxOp left behind
  // by a dispatcher crash between submission and its own confirmation. No-op
  // for txHashes with no matching op.
  await reconcileOutboxOpByTxHash(tx, event.txHash)

  const position = (await timedDbOperation(() =>
    tx.position.findFirst({
      where: {
        userId: user.id,
        protocolName: withdrawData.protocolName,
        assetSymbol: withdrawData.assetSymbol,
        status: 'ACTIVE',
      },
    })
  )) as any

  if (position) {
    const newDepositedAmount = new Decimal(position.depositedAmount).minus(
      withdrawData.amount
    )
    const newCurrentValue = new Decimal(position.currentValue).minus(
      withdrawData.amount
    )

    await timedDbOperation(() =>
      tx.position.update({
        where: { id: position.id },
        data: {
          depositedAmount: newDepositedAmount,
          currentValue: newCurrentValue,
          updatedAt: new Date(),
        },
      })
    )
    await timedDbOperation(() =>
      tx.transaction.update({
        where: { id: transaction.id },
        data: { positionId: position.id },
      })
    )
  }

  // Tax FIFO disposals (#284): recorded on the same `tx` handle, even when no
  // Position matched — the confirmed Transaction, not the Position, is the
  // disposal source of truth. Never throws; a shortfall alerts critically and
  // writes nothing (idempotent re-run after backfill repairs the ledger).
  await recordDisposalsForWithdrawal(
    user.id,
    transaction.id,
    withdrawData.assetSymbol,
    withdrawData.amount,
    transaction.confirmedAt ?? new Date(),
    tx,
    user.accountingMethod,
    transaction.selectedLotIds
  )

  return user.id
}

/**
 * Handle rebalance event - persist to database
 */
async function handleRebalanceEvent(
  rebalanceData: RebalanceEvent,
  event: ContractEvent,
  tx: any = db
): Promise<void> {
  await timedDbOperation(() =>
    tx.protocolRate.create({
      data: {
        protocolName: rebalanceData.protocol,
        assetSymbol: rebalanceData.assetSymbol,
        supplyApy: rebalanceData.apy,
        network: rebalanceData.network,
        fetchedAt: new Date(),
      },
    })
  )

  logger.info(
    `[Rebalance] Recorded protocol rate for ${rebalanceData.protocol} at ${rebalanceData.apy}%`
  )
}

/**
 * Handle contract event with persistence, idempotency, and validation (Issue #53)
 */
export async function handleEvent(
  event: ContractEvent,
  tx: any = db
): Promise<void> {
  const correlationId = generateCorrelationId()
  return runWithCorrelationIdAsync(correlationId, async () => {
    const eventWithCorrelation = { ...event, correlationId }
    const startTime = Date.now()
    try {
      logger.info(
        `[Event] ${event.type} detected at ledger ${event.ledger}, tx: ${event.txHash}`,
        {
          correlationId,
        }
      )

      // Issue #53: Event validation
      ContractEventSchema.parse(event)

      // Check if event was already processed (idempotency)
      const existingEvent = await timedDbOperation(() =>
        tx.processedEvent.findUnique({
          where: {
            contractId_txHash_eventType_ledger: {
              contractId: event.contractId,
              txHash: event.txHash,
              eventType: event.type,
              ledger: event.ledger,
            },
          },
        })
      )

      if (existingEvent) {
        logger.info(
          `[Event] Skipping duplicate event: ${event.type} at ledger ${event.ledger}`
        )
        return
      }

      switch (event.type) {
        case 'deposit': {
          const depositData = parseDepositEvent(event)
          DepositEventSchema.parse(depositData)
          const depositUserId = await handleDepositEvent(depositData, event, tx)
          // #316: one call now feeds both the operator webhook and the
          // depositor's live socket. Fire-and-forget, as before — a
          // notification problem must never roll back a confirmed deposit.
          publishUserEvent(
            depositUserId,
            EVENT_TYPE_TOPIC['deposit.received'],
            'deposit.received',
            { txHash: event.txHash, ...depositData }
          ).catch(() => {})
          break
        }

        case 'withdraw': {
          const withdrawData = parseWithdrawEvent(event)
          WithdrawEventSchema.parse(withdrawData)
          const withdrawUserId = await handleWithdrawEvent(
            withdrawData,
            event,
            tx
          )
          publishUserEvent(
            withdrawUserId,
            EVENT_TYPE_TOPIC['withdraw.completed'],
            'withdraw.completed',
            { txHash: event.txHash, ...withdrawData }
          ).catch(() => {})
          break
        }

        case 'rebalance': {
          const rebalanceData = parseRebalanceEvent(event)
          RebalanceEventSchema.parse(rebalanceData)
          await handleRebalanceEvent(rebalanceData, event, tx)
          // Contract-level rebalance events are protocol-wide, not user-scoped:
          // there is no user to address a stream frame to, so this one stays on
          // the operator webhook channel alone. The per-user view of a
          // rebalance is emitted by the agent loop, which knows whose positions
          // moved. Passing an empty user list keeps the single emit path.
          publishUserEvent(
            [],
            EVENT_TYPE_TOPIC['agent.rebalanced'],
            'agent.rebalanced',
            { txHash: event.txHash, ...rebalanceData }
          ).catch(() => {})
          break
        }
        default:
          throw new Error(`Unknown event type: ${event.type}`)
      }

      // Mark event as processed
      await timedDbOperation(() =>
        tx.processedEvent.create({
          data: {
            contractId: event.contractId,
            txHash: event.txHash,
            eventType: event.type,
            ledger: event.ledger,
          },
        })
      )

      recordProcessed()
      // Record Prometheus metrics
      recordEventProcessed(event.type)
      const duration = (Date.now() - startTime) / 1000
      recordEventDuration(event.type, duration)
      logger.info(`[Event] Successfully processed ${event.type} event`, {
        correlationId,
      })
    } catch (error) {
      recordError()
      // Record Prometheus metrics for failure
      const errorType =
        error instanceof Error ? error.constructor.name : 'Unknown'
      recordEventFailed(event.type, errorType)
      const duration = (Date.now() - startTime) / 1000
      recordEventDuration(event.type, duration)

      logger.error(`[Event Error] Failed to handle ${event.type}:`, {
        correlationId,
        error: error instanceof Error ? error.message : 'Unknown error',
      })
      // Issue #54: Store in Dead-Letter Queue
      await DeadLetterQueue.add(
        eventWithCorrelation,
        error instanceof Error ? error.message : 'Unknown error'
      )
      throw error // Rethrow so transaction can rollback if running inside one
    }
  })
}

type RpcEventPage = Awaited<ReturnType<rpc.Server['getEvents']>>
type RpcEventRecord = RpcEventPage['events'][number]

const CONTRACT_FILTERS: Array<{ type: 'contract'; contractIds: string[] }> = [
  { type: 'contract', contractIds: [VAULT_CONTRACT_ID] },
]

/**
 * Soroban getEvents returns one page per call. Follow the returned cursor
 * until the page is empty so no event past the first page is skipped, and
 * route every call through the failover-aware client.
 */
async function fetchAllEventPages(
  startLedger: number,
  finalLedger: number
): Promise<{ pages: RpcEventPage[]; complete: boolean }> {
  const client = getResilientClient()
  const pages: RpcEventPage[] = []
  const seenCursors = new Set<string>()
  let cursor: string | undefined
  // A broken endpoint echoing the same cursor forever must not hang the poll.
  const MAX_PAGES = 1000

  for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex++) {
    const page = await client.execute(
      (server) =>
        cursor
          ? server.getEvents({ cursor, filters: CONTRACT_FILTERS })
          : server.getEvents({ startLedger, filters: CONTRACT_FILTERS }),
      'events.getEvents'
    )
    pages.push(page)

    const inRange = page.events.filter((event) => event.ledger <= finalLedger)
    if (page.events.length === 0 || inRange.length < page.events.length) {
      return { pages, complete: true }
    }

    const nextCursor = page.cursor
    if (!nextCursor) return { pages, complete: true }
    if (nextCursor === cursor || seenCursors.has(nextCursor)) {
      // Same page again: there may be more events we can no longer reach.
      return { pages, complete: false }
    }
    seenCursors.add(nextCursor)
    cursor = nextCursor
  }
  return { pages, complete: false }
}

function toContractEvents(
  events: RpcEventRecord[],
  maxLedger: number
): ContractEvent[] {
  const result: ContractEvent[] = []
  for (const event of events) {
    if (event.ledger > maxLedger) continue
    const topics = event.topic
    const eventType = topics.length > 0 ? scValToNative(topics[0]) : null

    if (['deposit', 'withdraw', 'rebalance'].includes(eventType as string)) {
      result.push({
        type: eventType as 'deposit' | 'withdraw' | 'rebalance',
        ledger: event.ledger,
        txHash: event.txHash,
        contractId:
          typeof event.contractId === 'string'
            ? event.contractId
            : VAULT_CONTRACT_ID,
        topics,
        value: event.value,
      })
    }
  }
  return result
}

/** Ascending-ledger batches: a ledger is only "done" once all its events are. */
function groupEventsByLedger(
  events: ContractEvent[]
): Array<[number, ContractEvent[]]> {
  const byLedger = new Map<number, ContractEvent[]>()
  for (const event of events) {
    const batch = byLedger.get(event.ledger) ?? []
    batch.push(event)
    byLedger.set(event.ledger, batch)
  }
  return Array.from(byLedger.entries()).sort((a, b) => a[0] - b[0])
}

async function processEventBatchWithResult(
  events: ContractEvent[]
): Promise<{ failed: ContractEvent[] }> {
  if (events.length === 0) return { failed: [] }

  const start = Date.now()
  logger.info(
    `[Batch Processing] Attempting to process ${events.length} events`
  )

  try {
    await db.$transaction(async (tx) => {
      for (const event of events) {
        await handleEvent(event, tx)
      }
    })
    logger.info(
      `[Batch Processing] Throughput: Successfully processed batch of ${events.length} events in ${Date.now() - start}ms`
    )
    return { failed: [] }
  } catch (batchError) {
    logger.error(
      `[Batch Processing Error] Transaction failed, falling back to individual processing:`,
      batchError
    )
    // Fallback: Process individually so robust events succeed. Report the ones
    // that still fail so the caller can hold the cursor before that ledger.
    const failed: ContractEvent[] = []
    for (const event of events) {
      try {
        await handleEvent(event, db)
      } catch (individualError) {
        failed.push(event)
        logger.error(
          `[Batch Fallback Error] Event processing completely failed for ${event.txHash}`,
          individualError
        )
      }
    }
    return { failed }
  }
}

/**
 * Process a batch of events in a single transaction (Issue #55)
 */
export async function processEventBatch(
  events: ContractEvent[]
): Promise<void> {
  await processEventBatchWithResult(events)
}

/**
 * Load last processed ledger from database
 */
async function loadLastProcessedLedger(): Promise<number> {
  const cursor = await db.eventCursor.findUnique({
    where: { contractId: VAULT_CONTRACT_ID },
  })

  if (cursor) {
    logger.info(
      `[Event Listener] Resuming from ledger ${cursor.lastProcessedLedger}`
    )
    return cursor.lastProcessedLedger
  }

  // First time - start from one before latest so we catch recent events
  const latestLedger = await getResilientClient().execute(
    (server) => server.getLatestLedger(),
    'events.getLatestLedger'
  )
  const startLedger = Math.max(0, latestLedger.sequence - 1)
  logger.info(`[Event Listener] First run, starting from ledger ${startLedger}`)
  return startLedger
}

/**
 * Update last processed ledger in database
 */
async function persistLastProcessedLedger(ledger: number): Promise<void> {
  await db.eventCursor.upsert({
    where: { contractId: VAULT_CONTRACT_ID },
    update: {
      lastProcessedLedger: ledger,
      lastProcessedAt: new Date(),
    },
    create: {
      contractId: VAULT_CONTRACT_ID,
      lastProcessedLedger: ledger,
    },
  })
}

/**
 * Fetch and process events from ledger range with Batching (Issue #55)
 */
async function fetchEvents(startLedger: number): Promise<void> {
  try {
    const latestLedger = await getResilientClient().execute(
      (server) => server.getLatestLedger(),
      'events.getLatestLedger'
    )

    if (startLedger > latestLedger.sequence) {
      return // No new ledgers
    }

    recordLedgerLag(latestLedger.sequence)

    const { pages, complete } = await fetchAllEventPages(
      startLedger,
      latestLedger.sequence
    )
    const allEvents = pages.flatMap((page) =>
      toContractEvents(page.events, latestLedger.sequence)
    )

    // Only advance to ledgers whose events were ALL handled successfully.
    // A ledger that failed any event stays as the next poll's start ledger;
    // handleEvent's processed-event dedupe makes that replay safe.
    let safeLedger = startLedger - 1
    let failedLedger: number | null = null
    for (const [ledger, batch] of groupEventsByLedger(allEvents)) {
      const { failed } = await processEventBatchWithResult(batch)
      if (failed.length > 0) {
        failedLedger = ledger
        break
      }
      safeLedger = ledger
    }

    if (failedLedger === null && complete) {
      // All pages were fetched and processed; empty ledgers are done too.
      safeLedger = latestLedger.sequence
    } else if (failedLedger === null) {
      logger.warn(
        `[Event Listener] Pagination stopped before exhaustion; cursor held at ledger ${safeLedger}`
      )
    } else {
      logger.warn(
        `[Event Listener] Holding cursor at ledger ${safeLedger}; ledger ${failedLedger} still has failed events`
      )
    }

    await persistLastProcessedLedger(safeLedger)
    lastProcessedLedger = safeLedger
    updateLastProcessedLedger(safeLedger)
  } catch (error) {
    logger.error(
      '[Event Listener] Error fetching events:',
      error instanceof Error ? error.message : 'Unknown error'
    )
  }
}

/**
 * Backfill events for range-based reprocessing (Issue #59)
 */
export async function backfillEvents(
  startLedger: number,
  endLedger?: number
): Promise<void> {
  const client = getResilientClient()
  const latestLedger = await client.execute(
    (server) => server.getLatestLedger(),
    'events.getLatestLedger'
  )
  const finalLedger =
    endLedger && endLedger <= latestLedger.sequence
      ? endLedger
      : latestLedger.sequence

  logger.info(
    `[Backfill] Starting range reprocessing from ${startLedger} to ${finalLedger}`
  )

  const CHUNK_SIZE = 100
  for (
    let current = startLedger;
    current <= finalLedger;
    current += CHUNK_SIZE
  ) {
    const chunkEnd = Math.min(current + CHUNK_SIZE - 1, finalLedger)
    try {
      const { pages } = await fetchAllEventPages(current, chunkEnd)
      for (const page of pages) {
        for (const [, batch] of groupEventsByLedger(
          toContractEvents(page.events, chunkEnd)
        )) {
          await processEventBatch(batch)
        }
      }
    } catch (error) {
      logger.error(
        `[Backfill Error] Failed range ${current}-${chunkEnd}:`,
        error instanceof Error ? error.message : 'Unknown error'
      )
    }
  }
  logger.info(`[Backfill] Range reprocessing completed.`)
}

/**
 * Manual intervention: Retry failed events from DLQ (Issue #54)
 */
export async function retryDeadLetterEvents(): Promise<void> {
  logger.info(`[DLQ] Starting manual intervention retry for all DLQ events`)
  await DeadLetterQueue.retryAll(async (eventPayload) => {
    await handleEvent(eventPayload, db)
  })
}

/**
 * Start event listener with fault recovery check (Issue #59)
 */
export async function startEventListener(): Promise<void> {
  if (isListening) {
    logger.warn('[Event Listener] Already running')
    return
  }

  if (!VAULT_CONTRACT_ID) {
    throw new Error('VAULT_CONTRACT_ID not configured')
  }

  isListening = true

  // Load last processed ledger from database
  lastProcessedLedger = await loadLastProcessedLedger()

  logger.info(`[Event Listener] Started at ledger ${lastProcessedLedger}`)

  // Fault recovery: Check if we are lagging significantly behind latest ledger
  try {
    const latestLedger = await getResilientClient().execute(
      (server) => server.getLatestLedger(),
      'events.getLatestLedger'
    )
    if (latestLedger.sequence > lastProcessedLedger + 1) {
      logger.info(
        `[Fault Recovery] Downtime detected. Backfilling missed events from ${lastProcessedLedger + 1} to ${latestLedger.sequence}`
      )
      await backfillEvents(lastProcessedLedger + 1, latestLedger.sequence)
    }
  } catch (error) {
    logger.error(
      '[Fault Recovery Error] Failed to perform backfill on startup:',
      error
    )
  }

  // Poll loop
  const poll = async () => {
    if (!isListening) return

    try {
      await fetchEvents(lastProcessedLedger + 1)
    } catch (error) {
      logger.error(
        '[Event Listener] Poll error:',
        error instanceof Error ? error.message : 'Unknown error'
      )
    }

    setTimeout(poll, POLL_INTERVAL_MS)
  }

  poll()
}

/**
 * Stop event listener
 */
export function stopEventListener(): void {
  isListening = false
  logger.info('[Event Listener] Stopped')
}

/**
 * Get last processed ledger
 */
export function getLastProcessedLedger(): number {
  return lastProcessedLedger
}
