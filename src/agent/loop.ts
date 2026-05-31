/**
 * Agent Loop - Main orchestration of scheduled and event-based agent tasks
 */

import cron, { ScheduledTask } from 'node-cron';
import { logger } from '../utils/logger';
import { scanAllProtocols } from './scanner';
import { executeRebalanceIfNeeded, getThresholds, logAgentAction } from './router';
import { captureAllUserBalances, cleanupOldSnapshots } from './snapshotter';
import db from '../db';
import {
  updateAgentHeartbeat,
  updateAgentStatus,
  recordRebalanceCheck,
  recordRebalanceTriggered,
  recordDbOperation
} from '../utils/metrics';

let isRunning = false;
let lastRebalanceAt: Date | null = null;
let currentProtocol: string | null = null;
let currentApy: number | null = null;
let lastError: string | null = null;

// Store cron job references for cleanup
const cronJobs: ScheduledTask[] = [];

/**
 * Get current agent status
 */
export function getAgentStatus() {
  return {
    isRunning,
    lastRebalanceAt,
    currentProtocol,
    currentApy,
    nextScheduledCheck: getNextCheckTime(),
    lastError,
    healthStatus: determineHealthStatus(),
  };
}

/**
 * Determine agent health status
 */
function determineHealthStatus(): 'healthy' | 'degraded' | 'error' {
  if (!isRunning) return 'error';
  if (lastError) return 'degraded';
  return 'healthy';
}

/**
 * Calculate next scheduled check time
 */
function getNextCheckTime(): Date {
  // Rebalance check runs hourly at :00
  const now = new Date();
  const nextHour = new Date(now);
  nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
  return nextHour;
}

/**
 * Main rebalance check job - runs every hour at :00
 */
async function rebalanceCheckJob(): Promise<void> {
  const jobName = 'Hourly Rebalance Check';
  const startTime = Date.now();

  try {
    logger.info(`${jobName} started`);
    // Update heartbeat
    updateAgentHeartbeat();

    // Get all active positions
    const positions = await db.position.findMany({
      where: {
        status: 'ACTIVE',
      },
      include: {
        user: true,
      },
    });

    if (positions.length === 0) {
      logger.info('No active positions to rebalance');
      recordRebalanceCheck('success');
      return;
    }

    // Group by protocol to check each
    const byProtocol = new Map<string, typeof positions>();
    for (const pos of positions) {
      const key = pos.protocolName;
      if (!byProtocol.has(key)) {
        byProtocol.set(key, []);
      }
      byProtocol.get(key)!.push(pos);
    }

    // Check rebalance for each protocol group
    let rebalancesTriggered = 0;
    const thresholds = getThresholds();

    for (const [protocol, protocolPositions] of byProtocol.entries()) {
      const result = await executeRebalanceIfNeeded(
        protocol,
        // Explicit param type avoids `implicit any` under strict TS.
        protocolPositions.map((p: any) => ({
          id: p.id,
          amount: p.currentValue.toString(),
        })),
        thresholds
      );

      if (result) {
        rebalancesTriggered++;
        lastRebalanceAt = new Date();
        currentProtocol = result.toProtocol;
        currentApy = result.improvedBy;
        recordRebalanceTriggered();
      }
    }

    const duration = Date.now() - startTime;

    await logAgentAction('ANALYZE', 'SUCCESS', {
      positionsChecked: positions.length,
      rebalancesTriggered,
      duration,
    });

    // Record Prometheus metrics
    recordRebalanceCheck('success');
    recordDbOperation('rebalance_check', duration / 1000);

    logger.info(`${jobName} completed`, {
      duration,
      positionsChecked: positions.length,
      rebalancesTriggered,
    });

    lastError = null;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    lastError = errorMessage;

    const duration = Date.now() - startTime;
    logger.error(`${jobName} failed`, {
      error: errorMessage,
      duration,
    });

    // Record Prometheus metrics
    recordRebalanceCheck('failed');
    recordDbOperation('rebalance_check', duration / 1000);

    await logAgentAction('ANALYZE', 'FAILED', {
      error: errorMessage,
    });
  }
}

/**
 * Snapshot job - runs every hour at :30
 */
async function snapshotJob(): Promise<void> {
  const jobName = 'Hourly Balance Snapshot';
  const startTime = Date.now();

  try {
    logger.info(`${jobName} started`);
    // Update heartbeat
    updateAgentHeartbeat();

    // Run snapshot in background to avoid blocking rebalance checks
    captureAllUserBalances().catch(error => {
      logger.error('Background snapshot failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    });

    // Run cleanup in background (once per day at :30 past 1 AM)
    const now = new Date();
    if (now.getHours() === 1) {
      cleanupOldSnapshots().catch(error => {
        logger.error('Snapshot cleanup background job failed', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      });
    }

    const duration = Date.now() - startTime;
    // Record Prometheus metrics
    recordDbOperation('snapshot_job', duration / 1000);
    logger.info(`${jobName} scheduled`, { duration });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const duration = Date.now() - startTime;
    logger.error(`${jobName} failed`, {
      error: errorMessage,
      duration,
    });
    // Record Prometheus metrics
    recordDbOperation('snapshot_job', duration / 1000);
  }
}

/**
 * Initialize and start the agent loop
 * Called once on server startup
 */
export async function startAgentLoop(): Promise<void> {
  if (isRunning) {
    logger.warn('Agent loop already running');
    return;
  }

  try {
    logger.info('🤖 Starting NeuroWealth Agent Loop');
    // Update Prometheus metrics
    updateAgentStatus('running');
    updateAgentHeartbeat();

    // Run jobs immediately on startup
    logger.info('Running initial jobs...');
    await rebalanceCheckJob();
    await snapshotJob();

    // Schedule hourly rebalance check at :00
    const rebalanceJob = cron.schedule('0 * * * *', async () => {
      await rebalanceCheckJob();
    });
    cronJobs.push(rebalanceJob);
    logger.info('✓ Rebalance check scheduled: Every hour at :00');

    // Schedule hourly snapshot at :30
    const snapJob = cron.schedule('30 * * * *', async () => {
      await snapshotJob();
    });
    cronJobs.push(snapJob);
    logger.info('✓ Balance snapshot scheduled: Every hour at :30');

    // Daily protocol scan at 2 AM
    const scanJob = cron.schedule('0 2 * * *', async () => {
      try {
        logger.info('Daily protocol scan started');
        updateAgentHeartbeat();
        const protocols = await scanAllProtocols();
        logger.info('Daily protocol scan complete', {
          protocolsScanned: protocols.length,
        });
      } catch (error) {
        logger.error('Daily protocol scan failed', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });
    cronJobs.push(scanJob);
    logger.info('✓ Daily protocol scan scheduled: Daily at 2 AM');

    isRunning = true;
    logger.info('✅ NeuroWealth Agent Loop started successfully');

    // Setup graceful shutdown
    setupGracefulShutdown();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    lastError = errorMessage;
    // Update Prometheus metrics for error state
    updateAgentStatus('degraded');
    logger.error('Failed to start agent loop', { error: errorMessage });
    throw error;
  }
}

/**
 * Stop the agent loop gracefully
 */
export async function stopAgentLoop(): Promise<void> {
  if (!isRunning) {
    logger.warn('Agent loop is not running');
    return;
  }

  try {
    logger.info('Stopping NeuroWealth Agent Loop...');

    // Stop all cron jobs
    cronJobs.forEach(job => {
      job.stop();
      job.destroy();
    });
    cronJobs.length = 0;

    isRunning = false;
    logger.info('✅ Agent loop stopped gracefully');
  } catch (error) {
    logger.error('Error stopping agent loop', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * Setup graceful shutdown handlers
 */
function setupGracefulShutdown(): void {
  // Handle uncaught exceptions
  process.on('uncaughtException', error => {
    logger.error('Uncaught exception in agent', {
      error: error instanceof Error ? error.message : String(error),
    });
    lastError = error instanceof Error ? error.message : 'Uncaught exception';
  });

  process.on('unhandledRejection', reason => {
    logger.error('Unhandled rejection in agent', {
      reason: reason instanceof Error ? reason.message : String(reason),
    });
    lastError =
      reason instanceof Error ? reason.message : 'Unhandled rejection';
  });
}

/**
 * Export for testing
 */
export { rebalanceCheckJob, snapshotJob };
