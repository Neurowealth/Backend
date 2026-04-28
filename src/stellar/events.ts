import { rpc, scValToNative, xdr } from '@stellar/stellar-sdk';
import { PrismaClient, TransactionType, TransactionStatus, Network } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { getRpcServer } from './client';
import { ContractEvent, DepositEvent, WithdrawEvent, RebalanceEvent, EventMetrics } from './types';
import { logger } from '../utils/logger';
import { config } from '../config';

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
async function handleDepositEvent(depositData: DepositEvent, event: ContractEvent): Promise<void> {
  const user = await timedDbOperation(() =>
    prisma.user.findUnique({ where: { walletAddress: depositData.user } })
  );

  if (!user) {
    logger.warn(`[Deposit] User not found for wallet: ${depositData.user}`);
    return;
  }

  const transaction = await timedDbOperation(() =>
    prisma.transaction.upsert({
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
  );

  const position = await timedDbOperation(() =>
    prisma.position.findFirst({
      where: { userId: user.id, protocolName: depositData.protocolName, status: 'ACTIVE' },
    })
  );

  if (position) {
    await timedDbOperation(() =>
      prisma.position.update({
        where: { id: position.id },
        data: {
          depositedAmount: { increment: depositData.amount },
          currentValue: { increment: depositData.amount },
          updatedAt: new Date(),
        },
      })
    );
    await timedDbOperation(() =>
      prisma.transaction.update({ where: { id: transaction.id }, data: { positionId: position.id } })
    );
  } else {
    const newPosition = await timedDbOperation(() =>
      prisma.position.create({
        data: {
          userId: user.id,
          protocolName: depositData.protocolName,
          assetSymbol: depositData.assetSymbol,
          depositedAmount: depositData.amount,
          currentValue: depositData.amount,
          yieldEarned: 0,
        },
      })
    );
    await timedDbOperation(() =>
      prisma.transaction.update({ where: { id: transaction.id }, data: { positionId: newPosition.id } })
    );
  }
}

/**
 * Handle withdraw event - persist to database
 */
async function handleWithdrawEvent(withdrawData: WithdrawEvent, event: ContractEvent): Promise<void> {
  const user = await timedDbOperation(() =>
    prisma.user.findUnique({ where: { walletAddress: withdrawData.user } })
  );

  if (!user) {
    logger.warn(`[Withdraw] User not found for wallet: ${withdrawData.user}`);
    return;
  }

  const transaction = await timedDbOperation(() =>
    prisma.transaction.upsert({
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
  );

  const position = await timedDbOperation(() =>
    prisma.position.findFirst({
      where: { userId: user.id, protocolName: withdrawData.protocolName, status: 'ACTIVE' },
    })
  );

  if (position) {
    const newDepositedAmount = new Decimal(position.depositedAmount).minus(withdrawData.amount);
    const newCurrentValue = new Decimal(position.currentValue).minus(withdrawData.amount);

    await timedDbOperation(() =>
      prisma.position.update({
        where: { id: position.id },
        data: { depositedAmount: newDepositedAmount, currentValue: newCurrentValue, updatedAt: new Date() },
      })
    );
    await timedDbOperation(() =>
      prisma.transaction.update({ where: { id: transaction.id }, data: { positionId: position.id } })
    );
  }
}

/**
 * Handle rebalance event - persist to database
 */
async function handleRebalanceEvent(rebalanceData: RebalanceEvent, event: ContractEvent): Promise<void> {
  await timedDbOperation(() =>
    prisma.protocolRate.create({
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
 * Handle contract event with persistence and idempotency
 */
async function handleEvent(event: ContractEvent): Promise<void> {
  try {
    logger.info(`[Event] ${event.type} detected at ledger ${event.ledger}, tx: ${event.txHash}`);

    // Check if event was already processed (idempotency)
    const existingEvent = await timedDbOperation(() =>
      prisma.processedEvent.findUnique({
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
        logger.info(`[Deposit] User: ${depositData.user}, Amount: ${depositData.amount}, Shares: ${depositData.shares}, Asset: ${depositData.assetSymbol}, Protocol: ${depositData.protocolName}, Network: ${depositData.network}`);
        await handleDepositEvent(depositData, event);
        break;
      }

      case 'withdraw': {
        const withdrawData = parseWithdrawEvent(event);
        logger.info(`[Withdraw] User: ${withdrawData.user}, Amount: ${withdrawData.amount}, Shares: ${withdrawData.shares}, Asset: ${withdrawData.assetSymbol}, Protocol: ${withdrawData.protocolName}, Network: ${withdrawData.network}`);
        await handleWithdrawEvent(withdrawData, event);
        break;
      }

      case 'rebalance': {
        const rebalanceData = parseRebalanceEvent(event);
        logger.info(`[Rebalance] Protocol: ${rebalanceData.protocol}, APY: ${rebalanceData.apy}%, Asset: ${rebalanceData.assetSymbol}, Network: ${rebalanceData.network}`);
        await handleRebalanceEvent(rebalanceData, event);
        break;
      }
    }

    // Mark event as processed
    await timedDbOperation(() =>
      prisma.processedEvent.create({
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
 * Fetch and process events from ledger range
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

    for (const event of events.events) {
      const topics = event.topic;
      const eventType = topics.length > 0 ? scValToNative(topics[0]) : null;

      if (['deposit', 'withdraw', 'rebalance'].includes(eventType)) {
        const contractEvent: ContractEvent = {
          type: eventType as 'deposit' | 'withdraw' | 'rebalance',
          ledger: event.ledger,
          txHash: event.txHash,
          contractId: typeof event.contractId === 'string' ? event.contractId : VAULT_CONTRACT_ID,
          topics: topics,
          value: event.value,
        };

        await handleEvent(contractEvent);
      }
    }

    // Update cursor in database
    await updateLastProcessedLedger(latestLedger.sequence);
    lastProcessedLedger = latestLedger.sequence;
  } catch (error) {
    logger.error('[Event Listener] Error fetching events:', error instanceof Error ? error.message : 'Unknown error');
  }
}

/**
 * Start event listener
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
