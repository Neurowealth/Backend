import { rpc, scValToNative, xdr } from '@stellar/stellar-sdk';
import { PrismaClient, TransactionType, TransactionStatus, Network } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { getRpcServer } from './client';
import { ContractEvent, DepositEvent, WithdrawEvent, RebalanceEvent, EventMetrics } from './types';
import { logger } from '../utils/logger';
import { config } from '../config';
import { DeadLetterQueue } from './dlq';
import { 
  ContractEventSchema, 
  DepositEventSchema, 
  WithdrawEventSchema, 
  RebalanceEventSchema 
} from '../validators/event-validator';

const VAULT_CONTRACT_ID = process.env.VAULT_CONTRACT_ID || '';
const POLL_INTERVAL_MS = 5000;

const prisma = new PrismaClient();

let lastProcessedLedger = 0;
let isListening = false;

// --- Metrics state (Issue #50) ---
const metrics: EventMetrics = {
  totalProcessed: 0,
  totalErrors: 0,
  processingRatePerMinute: 0,
  errorRate: 0,
  ledgerLag: 0,
  lastDbOperationMs: 0,
  lastUpdated: new Date(),
};

// Rolling window for processing rate (events in last 60s)
const processingTimestamps: number[] = [];

function recordProcessed(): void {
  const now = Date.now();
  processingTimestamps.push(now);
  // Keep only last 60 seconds
  const cutoff = now - 60_000;
  while (processingTimestamps.length > 0 && processingTimestamps[0] < cutoff) {
    processingTimestamps.shift();
  }
  metrics.totalProcessed++;
  metrics.processingRatePerMinute = processingTimestamps.length;
  metrics.errorRate = metrics.totalProcessed > 0 ? metrics.totalErrors / metrics.totalProcessed : 0;
  metrics.lastUpdated = new Date();
}

function recordError(): void {
  metrics.totalErrors++;
  metrics.errorRate = metrics.totalProcessed > 0 ? metrics.totalErrors / metrics.totalProcessed : 0;
  metrics.lastUpdated = new Date();
}

function recordLedgerLag(latestLedger: number): void {
  metrics.ledgerLag = latestLedger - lastProcessedLedger;
  metrics.lastUpdated = new Date();
}

async function timedDbOperation<T>(fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    metrics.lastDbOperationMs = Date.now() - start;
    metrics.lastUpdated = new Date();
  }
}

/**
 * Get current event processing metrics (Issue #50)
 */
export function getEventMetrics(): Readonly<EventMetrics> {
  return { ...metrics };
}

// --- Event context extraction helpers (Issue #51) ---

/**
 * Extract asset symbol from event topics or value.
 * Topics[1] carries the asset symbol when present; falls back to 'USDC'.
 */
function extractAssetSymbol(event: ContractEvent): string {
  if (event.topics.length > 1) {
    try {
      const raw = scValToNative(event.topics[1]);
      if (typeof raw === 'string' && raw.length > 0) return raw;
    } catch {
      // fall through to default
    }
  }
  return 'USDC';
}

/**
 * Extract protocol name from event topics or value.
 * Topics[2] carries the protocol name when present; falls back to 'vault'.
 */
function extractProtocolName(event: ContractEvent): string {
  if (event.topics.length > 2) {
    try {
      const raw = scValToNative(event.topics[2]);
      if (typeof raw === 'string' && raw.length > 0) return raw;
    } catch {
      // fall through to default
    }
  }
  return 'vault';
}

/**
 * Extract network from config (canonical source of truth).
 */
function extractNetwork(): Network {
  const n = config.stellar.network.toUpperCase();
  if (n === 'TESTNET') return Network.TESTNET;
  if (n === 'FUTURENET') return Network.FUTURENET;
  return Network.MAINNET;
}

/**
 * Parse deposit event
 */
function parseDepositEvent(event: ContractEvent): DepositEvent {
  const data = scValToNative(event.value);
  return {
    user: data.user,
    amount: data.amount?.toString() || '0',
    shares: data.shares?.toString() || '0',
    assetSymbol: extractAssetSymbol(event),
    protocolName: extractProtocolName(event),
    network: extractNetwork(),
  };
}

/**
 * Parse withdraw event
 */
function parseWithdrawEvent(event: ContractEvent): WithdrawEvent {
  const data = scValToNative(event.value);
  return {
    user: data.user,
    amount: data.amount?.toString() || '0',
    shares: data.shares?.toString() || '0',
    assetSymbol: extractAssetSymbol(event),
    protocolName: extractProtocolName(event),
    network: extractNetwork(),
  };
}

/**
 * Parse rebalance event
 */
function parseRebalanceEvent(event: ContractEvent): RebalanceEvent {
  const data = scValToNative(event.value);
  return {
    protocol: data.protocol,
    apy: data.apy / 100, // Convert basis points to percentage
    timestamp: data.timestamp,
    assetSymbol: extractAssetSymbol(event),
    network: extractNetwork(),
  };
}

/**
 * Handle deposit event - persist to database
 */
async function handleDepositEvent(depositData: DepositEvent, event: ContractEvent, tx: any = prisma): Promise<void> {
  const user = await timedDbOperation(() =>
    tx.user.findUnique({ where: { walletAddress: depositData.user } })
  ) as any;

  if (!user) {
    logger.warn(`[Deposit] User not found for wallet: ${depositData.user}`);
    throw new Error(`[Deposit] User not found for wallet: ${depositData.user}`);
  }

  const transaction = await timedDbOperation(() =>
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
  ) as any;

  const position = await timedDbOperation(() =>
    tx.position.findFirst({
      where: { userId: user.id, protocolName: depositData.protocolName, assetSymbol: depositData.assetSymbol, status: 'ACTIVE' },
    })
  ) as any;

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
    );
    await timedDbOperation(() =>
      tx.transaction.update({ where: { id: transaction.id }, data: { positionId: position.id } })
    );
  } else {
    const newPosition = await timedDbOperation(() =>
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
    ) as any;
    await timedDbOperation(() =>
      tx.transaction.update({ where: { id: transaction.id }, data: { positionId: newPosition.id } })
    );
  }
}

/**
 * Handle withdraw event - persist to database
 */
async function handleWithdrawEvent(withdrawData: WithdrawEvent, event: ContractEvent, tx: any = prisma): Promise<void> {
  const user = await timedDbOperation(() =>
    tx.user.findUnique({ where: { walletAddress: withdrawData.user } })
  ) as any;

  if (!user) {
    logger.warn(`[Withdraw] User not found for wallet: ${withdrawData.user}`);
    throw new Error(`[Withdraw] User not found for wallet: ${withdrawData.user}`);
  }

  const transaction = await timedDbOperation(() =>
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
  ) as any;

  const position = await timedDbOperation(() =>
    tx.position.findFirst({
      where: { userId: user.id, protocolName: withdrawData.protocolName, assetSymbol: withdrawData.assetSymbol, status: 'ACTIVE' },
    })
  ) as any;

  if (position) {
    const newDepositedAmount = new Decimal(position.depositedAmount).minus(withdrawData.amount);
    const newCurrentValue = new Decimal(position.currentValue).minus(withdrawData.amount);

    await timedDbOperation(() =>
      tx.position.update({
        where: { id: position.id },
        data: { depositedAmount: newDepositedAmount, currentValue: newCurrentValue, updatedAt: new Date() },
      })
    );
    await timedDbOperation(() =>
      tx.transaction.update({ where: { id: transaction.id }, data: { positionId: position.id } })
    );
  }
}

/**
 * Handle rebalance event - persist to database
 */
async function handleRebalanceEvent(rebalanceData: RebalanceEvent, event: ContractEvent, tx: any = prisma): Promise<void> {
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
  );

  logger.info(`[Rebalance] Recorded protocol rate for ${rebalanceData.protocol} at ${rebalanceData.apy}%`);
}

/**
 * Handle contract event with persistence, idempotency, and validation (Issue #53)
 */
export async function handleEvent(event: ContractEvent, tx: any = prisma): Promise<void> {
  try {
    logger.info(`[Event] ${event.type} detected at ledger ${event.ledger}, tx: ${event.txHash}`);

    // Issue #53: Event validation
    ContractEventSchema.parse(event);

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
    );

    if (existingEvent) {
      logger.info(`[Event] Skipping duplicate event: ${event.type} at ledger ${event.ledger}`);
      return;
    }

    switch (event.type) {
      case 'deposit': {
        const depositData = parseDepositEvent(event);
        DepositEventSchema.parse(depositData);
        await handleDepositEvent(depositData, event, tx);
        break;
      }

      case 'withdraw': {
        const withdrawData = parseWithdrawEvent(event);
        WithdrawEventSchema.parse(withdrawData);
        await handleWithdrawEvent(withdrawData, event, tx);
        break;
      }

      case 'rebalance': {
        const rebalanceData = parseRebalanceEvent(event);
        RebalanceEventSchema.parse(rebalanceData);
        await handleRebalanceEvent(rebalanceData, event, tx);
        break;
      }
      default:
        throw new Error(`Unknown event type: ${event.type}`);
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
    );

    recordProcessed();
    logger.info(`[Event] Successfully processed ${event.type} event`);
  } catch (error) {
    recordError();
    logger.error(`[Event Error] Failed to handle ${event.type}:`, error instanceof Error ? error.message : 'Unknown error');
    // Issue #54: Store in Dead-Letter Queue
    await DeadLetterQueue.add(event, error instanceof Error ? error.message : 'Unknown error');
    throw error; // Rethrow so transaction can rollback if running inside one
  }
}

/**
 * Process a batch of events in a single transaction (Issue #55)
 */
export async function processEventBatch(events: ContractEvent[]): Promise<void> {
  const start = Date.now();
  let processedCount = 0;

  logger.info(`[Batch Processing] Attempting to process ${events.length} events`);

  try {
    // Multiple events processed in a single transaction
    await prisma.$transaction(async (tx) => {
      for (const event of events) {
        await handleEvent(event, tx);
        processedCount++;
      }
    });
    const duration = Date.now() - start;
    logger.info(`[Batch Processing] Throughput: Successfully processed batch of ${processedCount} events in ${duration}ms`);
  } catch (batchError) {
    logger.error(`[Batch Processing Error] Transaction failed, falling back to individual processing:`, batchError);
    // Fallback: Process individually so robust events succeed
    for (const event of events) {
      try {
        await handleEvent(event, prisma);
      } catch (individualError) {
        logger.error(`[Batch Fallback Error] Event processing completely failed for ${event.txHash}`);
      }
    }
  }
}

/**
 * Load last processed ledger from database
 */
async function loadLastProcessedLedger(): Promise<number> {
  const cursor = await prisma.eventCursor.findUnique({
    where: { contractId: VAULT_CONTRACT_ID },
  });

  if (cursor) {
    logger.info(`[Event Listener] Resuming from ledger ${cursor.lastProcessedLedger}`);
    return cursor.lastProcessedLedger;
  }

  // First time - start from one before latest so we catch recent events
  const server = getRpcServer();
  const latestLedger = await server.getLatestLedger();
  const startLedger = Math.max(0, latestLedger.sequence - 1);
  logger.info(`[Event Listener] First run, starting from ledger ${startLedger}`);
  return startLedger;
}

/**
 * Update last processed ledger in database
 */
async function updateLastProcessedLedger(ledger: number): Promise<void> {
  await prisma.eventCursor.upsert({
    where: { contractId: VAULT_CONTRACT_ID },
    update: {
      lastProcessedLedger: ledger,
      lastProcessedAt: new Date(),
    },
    create: {
      contractId: VAULT_CONTRACT_ID,
      lastProcessedLedger: ledger,
    },
  });
}

/**
 * Fetch and process events from ledger range with Batching (Issue #55)
 */
async function fetchEvents(startLedger: number): Promise<void> {
  const server = getRpcServer();

  try {
    const latestLedger = await server.getLatestLedger();

    if (startLedger > latestLedger.sequence) {
      return; // No new ledgers
    }

    recordLedgerLag(latestLedger.sequence);

    const events = await server.getEvents({
      startLedger,
      filters: [
        {
          type: 'contract',
          contractIds: [VAULT_CONTRACT_ID],
        },
      ],
    });

    const contractEvents: ContractEvent[] = [];
    for (const event of events.events) {
      const topics = event.topic;
      const eventType = topics.length > 0 ? scValToNative(topics[0]) : null;

      if (['deposit', 'withdraw', 'rebalance'].includes(eventType)) {
        contractEvents.push({
          type: eventType as 'deposit' | 'withdraw' | 'rebalance',
          ledger: event.ledger,
          txHash: event.txHash,
          contractId: typeof event.contractId === 'string' ? event.contractId : VAULT_CONTRACT_ID,
          topics: topics,
          value: event.value,
        });
      }
    }

    if (contractEvents.length > 0) {
      // Use batch processing
      await processEventBatch(contractEvents);
    }

    // Update cursor in database
    await updateLastProcessedLedger(latestLedger.sequence);
    lastProcessedLedger = latestLedger.sequence;
  } catch (error) {
    logger.error('[Event Listener] Error fetching events:', error instanceof Error ? error.message : 'Unknown error');
  }
}

/**
 * Backfill events for range-based reprocessing (Issue #59)
 */
export async function backfillEvents(startLedger: number, endLedger?: number): Promise<void> {
  const server = getRpcServer();
  const latestLedger = await server.getLatestLedger();
  const finalLedger = endLedger && endLedger <= latestLedger.sequence ? endLedger : latestLedger.sequence;

  logger.info(`[Backfill] Starting range reprocessing from ${startLedger} to ${finalLedger}`);

  const CHUNK_SIZE = 100;
  for (let current = startLedger; current <= finalLedger; current += CHUNK_SIZE) {
    const chunkEnd = Math.min(current + CHUNK_SIZE - 1, finalLedger);
    try {
      const events = await server.getEvents({
        startLedger: current,
        filters: [{ type: 'contract', contractIds: [VAULT_CONTRACT_ID] }],
      });

      const contractEvents: ContractEvent[] = [];
      for (const event of events.events) {
        const topics = event.topic;
        const eventType = topics.length > 0 ? scValToNative(topics[0]) : null;

        if (['deposit', 'withdraw', 'rebalance'].includes(eventType) && event.ledger <= chunkEnd) {
          contractEvents.push({
            type: eventType as 'deposit' | 'withdraw' | 'rebalance',
            ledger: event.ledger,
            txHash: event.txHash,
            contractId: typeof event.contractId === 'string' ? event.contractId : VAULT_CONTRACT_ID,
            topics: topics,
            value: event.value,
          });
        }
      }

      if (contractEvents.length > 0) {
        await processEventBatch(contractEvents);
      }
    } catch (error) {
      logger.error(`[Backfill Error] Failed range ${current}-${chunkEnd}:`, error instanceof Error ? error.message : 'Unknown error');
    }
  }
  logger.info(`[Backfill] Range reprocessing completed.`);
}

/**
 * Manual intervention: Retry failed events from DLQ (Issue #54)
 */
export async function retryDeadLetterEvents(): Promise<void> {
  logger.info(`[DLQ] Starting manual intervention retry for all DLQ events`);
  await DeadLetterQueue.retryAll(async (eventPayload) => {
    await handleEvent(eventPayload, prisma);
  });
}

/**
 * Start event listener with fault recovery check (Issue #59)
 */
export async function startEventListener(): Promise<void> {
  if (isListening) {
    logger.warn('[Event Listener] Already running');
    return;
  }

  if (!VAULT_CONTRACT_ID) {
    throw new Error('VAULT_CONTRACT_ID not configured');
  }

  isListening = true;

  // Load last processed ledger from database
  lastProcessedLedger = await loadLastProcessedLedger();

  logger.info(`[Event Listener] Started at ledger ${lastProcessedLedger}`);

  // Fault recovery: Check if we are lagging significantly behind latest ledger
  try {
    const server = getRpcServer();
    const latestLedger = await server.getLatestLedger();
    if (latestLedger.sequence > lastProcessedLedger + 1) {
      logger.info(`[Fault Recovery] Downtime detected. Backfilling missed events from ${lastProcessedLedger + 1} to ${latestLedger.sequence}`);
      await backfillEvents(lastProcessedLedger + 1, latestLedger.sequence);
    }
  } catch (error) {
    logger.error('[Fault Recovery Error] Failed to perform backfill on startup:', error);
  }

  // Poll loop
  const poll = async () => {
    if (!isListening) return;

    try {
      await fetchEvents(lastProcessedLedger + 1);
    } catch (error) {
      logger.error('[Event Listener] Poll error:', error instanceof Error ? error.message : 'Unknown error');
    }

    setTimeout(poll, POLL_INTERVAL_MS);
  };

  poll();
}

/**
 * Stop event listener
 */
export function stopEventListener(): void {
  isListening = false;
  logger.info('[Event Listener] Stopped');
}

/**
 * Get last processed ledger
 */
export function getLastProcessedLedger(): number {
  return lastProcessedLedger;
}
