/**
 * Agent Loop - Main orchestration of scheduled and event-based agent tasks
 */

import cron, { ScheduledTask } from 'node-cron'
import { logger, logBackgroundJob } from '../utils/logger'
import {
  generateCorrelationId,
  runWithCorrelationIdAsync,
} from '../utils/correlation'
import { scanAllProtocols } from './scanner'
import {
  executeRebalanceIfNeeded,
  getThresholds,
  logAgentAction,
} from './router'
import { dispatchWebhookEvent } from '../services/webhookDispatcher'
import { captureAllUserBalances, cleanupOldSnapshots } from './snapshotter'
import { resolveEffectiveConfig } from './effectiveStrategy'
import {
  loadActiveFollowsForUsers,
  type ActiveFollowConfig,
} from '../strategy/service'
import type { StrategyName } from './types'
import db from '../db'
import {
  updateAgentHeartbeat as metricsUpdateAgentHeartbeat,
  updateAgentStatus,
  recordRebalanceCheck,
  recordRebalanceTriggered,
  recordDbOperation,
  recordBackgroundJob,
  recordExternalServiceError,
} from '../utils/metrics'

let isRunning = false
let lastRebalanceAt: Date | null = null
let currentProtocol: string | null = null
let currentApy: number | null = null
let lastError: string | null = null
let lastTickAt: Date | null = null

// Store cron job references for cleanup
const cronJobs: ScheduledTask[] = []

function updateAgentHeartbeat(): void {
  lastTickAt = new Date()
  metricsUpdateAgentHeartbeat()
}

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
    lastTickAt,
  }
}

/**
 * Determine agent health status
 */
function determineHealthStatus(): 'healthy' | 'degraded' | 'error' {
  if (!isRunning) return 'error'
  if (lastError) return 'degraded'
  return 'healthy'
}

/**
 * Calculate next scheduled check time
 */
function getNextCheckTime(): Date {
  // Rebalance check runs hourly at :00
  const now = new Date()
  const nextHour = new Date(now)
  nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0)
  return nextHour
}

/**
 * Main rebalance check job - runs every hour at :00
 */
async function rebalanceCheckJob(): Promise<void> {
  const correlationId = generateCorrelationId()
  return runWithCorrelationIdAsync(correlationId, async () => {
    const jobName = 'rebalance_check'
    const startTime = Date.now()

    try {
      logger.info(`[${jobName}] started`, { correlationId })
      updateAgentHeartbeat()

      const positions = await db.position.findMany({
        where: {
          status: 'ACTIVE',
        },
        include: {
          user: true,
        },
      })

      if (positions.length === 0) {
        const duration = (Date.now() - startTime) / 1000
        logBackgroundJob(jobName, 'success', duration, correlationId, {
          positionsChecked: 0,
          rebalancesTriggered: 0,
        })
        recordRebalanceCheck('success')
        return
      }

      type PositionWithUser = (typeof positions)[number]

      // Strategy marketplace (#285): one query for the whole tick, not one per
      // user. Returns an empty Map when nobody in the batch follows anything —
      // which is the path every user without a follow takes.
      const userIds = Array.from(
        new Set(positions.map((p: PositionWithUser) => p.userId))
      )
      const followsByUser = await loadActiveFollowsForUsers(userIds)

      // Resolve each user's effective config once. With no follow this is the
      // user's own values read exactly as they were before #285 — the raw
      // strategyConfig fields, uncoerced — so the no-follow path stays a
      // byte-for-byte no-op (asserted by the regression test in
      // tests/integration/agent/strategy-follow.integration.test.ts).
      const effectiveByUser = new Map<
        string,
        {
          config: ReturnType<typeof resolveEffectiveConfig>
          follow?: ActiveFollowConfig
        }
      >()
      for (const pos of positions) {
        if (effectiveByUser.has(pos.userId)) continue
        const user = pos.user as any
        const own = {
          strategyName: (user.rebalanceStrategy || null) as StrategyName | null,
          targetAllocations:
            user.strategyConfig?.targetAllocations || undefined,
          riskCeiling: user.strategyConfig?.riskCeiling,
        }
        const follow = followsByUser.get(pos.userId)
        effectiveByUser.set(pos.userId, {
          config: resolveEffectiveConfig(own, follow?.appliedConfig),
          follow,
        })
      }

      // Group by (protocol, effective strategy, follow) so users with different
      // strategies are evaluated independently.
      //
      // HAZARD: router.ts reads only userStrategyPreferences[0]. Without the
      // follow component in this key, two followers of DIFFERENT published
      // strategies sharing a protocol would collapse into one batch and both be
      // rebalanced on index 0's config — including index 0's risk ceiling.
      // Keying on the per-user follow id (not the followed strategy id) is
      // deliberate: two followers of the SAME strategy can still have different
      // effective ceilings, because a follow clamps to the stricter of publisher
      // and follower. It costs some batching; it buys risk correctness.
      //
      // For users without a follow the component is the constant 'none', so
      // grouping is identical to before this feature.
      const byProtocolAndStrategy = new Map<
        string,
        { protocol: string; positions: PositionWithUser[] }
      >()
      for (const pos of positions) {
        const { config, follow } = effectiveByUser.get(pos.userId)!
        const key = `${pos.protocolName}:${config.strategyName || 'DEFAULT'}:${
          follow?.followId ?? 'none'
        }`
        if (!byProtocolAndStrategy.has(key)) {
          byProtocolAndStrategy.set(key, {
            protocol: pos.protocolName,
            positions: [],
          })
        }
        byProtocolAndStrategy.get(key)!.positions.push(pos)
      }

      let rebalancesTriggered = 0
      const thresholds = getThresholds()

      for (const batch of byProtocolAndStrategy.values()) {
        const { protocol, positions: protocolPositions } = batch
        const lead = effectiveByUser.get(protocolPositions[0].userId)!

        // HAZARD: this guard used to be `strategyName ? … : undefined`, and
        // executeRebalanceIfNeeded skips the strategy engine entirely when
        // preferences are undefined. A follower whose OWN rebalanceStrategy is
        // null — the common case for a new user, and exactly who this feature
        // targets — would have had their followed config silently ignored.
        const hasStrategyContext =
          Boolean(lead.config.strategyName) || Boolean(lead.follow)

        const userStrategyPreferences = hasStrategyContext
          ? protocolPositions.map((p: PositionWithUser) => {
              const { config, follow } = effectiveByUser.get(p.userId)!
              return {
                userId: p.userId,
                strategyName: config.strategyName,
                targetAllocations: config.targetAllocations,
                riskTolerance: (p.user as any).riskTolerance,
                // Opt-in risk ceiling (0-100 min protocol risk score). Absent for
                // users who never configured one, keeping agent behavior unchanged.
                // Under a follow this is already clamped to the STRICTER of
                // publisher and follower — see resolveEffectiveConfig.
                riskCeiling: config.riskCeiling,
                followedStrategyId: follow?.followedStrategyId ?? undefined,
              }
            })
          : undefined

        const result = await executeRebalanceIfNeeded(
          protocol,
          protocolPositions.map((p: any) => ({
            id: p.id,
            amount: p.currentValue.toString(),
            userId: p.userId,
          })),
          thresholds,
          userStrategyPreferences
        )

        if (result) {
          rebalancesTriggered++
          lastRebalanceAt = new Date()
          currentProtocol = result.toProtocol
          currentApy = result.improvedBy
          recordRebalanceTriggered()
          dispatchWebhookEvent('agent.rebalanced', {
            fromProtocol: result.fromProtocol,
            toProtocol: result.toProtocol,
            amount: result.amount,
            improvedBy: result.improvedBy,
            txHash: result.txHash,
            timestamp: result.timestamp,
          }).catch(() => {})
        }
      }

      const duration = (Date.now() - startTime) / 1000

      await logAgentAction('ANALYZE', 'SUCCESS', {
        input: {
          correlationId,
          positionsChecked: positions.length,
          rebalancesTriggered,
          duration,
        },
      })

      logBackgroundJob(jobName, 'success', duration, correlationId, {
        positionsChecked: positions.length,
        rebalancesTriggered,
      })

      recordRebalanceCheck('success')
      recordDbOperation('rebalance_check', duration)

      lastError = null
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error'
      lastError = errorMessage
      const duration = (Date.now() - startTime) / 1000

      logBackgroundJob(jobName, 'failed', duration, correlationId, {
        error: errorMessage,
      })

      recordRebalanceCheck('failed')
      recordDbOperation('rebalance_check', duration)

      await logAgentAction('ANALYZE', 'FAILED', {
        input: { correlationId },
        error: errorMessage,
      })
    }
  })
}

/**
 * Snapshot job - runs every hour at :30
 */
async function snapshotJob(): Promise<void> {
  const correlationId = generateCorrelationId()
  return runWithCorrelationIdAsync(correlationId, async () => {
    const jobName = 'Hourly Balance Snapshot'
    const startTime = Date.now()

    try {
      logger.info(`${jobName} started`, { correlationId })
      // Update heartbeat
      updateAgentHeartbeat()

      // Run snapshot in background to avoid blocking rebalance checks
      captureAllUserBalances().catch((error) => {
        logger.error('Background snapshot failed', {
          error: error instanceof Error ? error.message : 'Unknown error',
        })
      })

      // Run cleanup in background (once per day at :30 past 1 AM)
      const now = new Date()
      if (now.getHours() === 1) {
        cleanupOldSnapshots().catch((error) => {
          logger.error('Snapshot cleanup background job failed', {
            error: error instanceof Error ? error.message : 'Unknown error',
          })
        })
      }

      const duration = Date.now() - startTime
      // Record Prometheus metrics
      recordDbOperation('snapshot_job', duration / 1000)
      recordBackgroundJob('snapshot', 'success', duration / 1000)
      logger.info(`${jobName} scheduled`, { duration })
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error'
      const duration = Date.now() - startTime
      logger.error(`${jobName} failed`, {
        error: errorMessage,
        duration,
      })
      // Record Prometheus metrics
      recordDbOperation('snapshot_job', duration / 1000)
      recordBackgroundJob('snapshot', 'failed', duration / 1000)
    }
  })
}

/**
 * Initialize and start the agent loop
 * Called once on server startup
 */
export async function startAgentLoop(): Promise<void> {
  if (isRunning) {
    logger.warn('Agent loop already running')
    return
  }

  try {
    logger.info('🤖 Starting NeuroWealth Agent Loop')
    // Update Prometheus metrics
    updateAgentStatus('running')
    updateAgentHeartbeat()

    // Run jobs immediately on startup
    logger.info('Running initial jobs...')
    await rebalanceCheckJob()
    await snapshotJob()

    // Schedule hourly rebalance check at :00
    const rebalanceJob = cron.schedule('0 * * * *', async () => {
      await rebalanceCheckJob()
    })
    cronJobs.push(rebalanceJob)
    logger.info('✓ Rebalance check scheduled: Every hour at :00')

    // Schedule hourly snapshot at :30
    const snapJob = cron.schedule('30 * * * *', async () => {
      await snapshotJob()
    })
    cronJobs.push(snapJob)
    logger.info('✓ Balance snapshot scheduled: Every hour at :30')

    // Daily protocol scan at 2 AM
    const scanJob = cron.schedule('0 2 * * *', async () => {
      const correlationId = generateCorrelationId()
      return runWithCorrelationIdAsync(correlationId, async () => {
        try {
          logger.info('Daily protocol scan started', { correlationId })
          updateAgentHeartbeat()
          const scanStart = Date.now()
          const protocols = await scanAllProtocols()
          const scanDuration = (Date.now() - scanStart) / 1000
          await logAgentAction('SCAN', 'SUCCESS', {
            input: { correlationId, protocolsScanned: protocols.length },
          })
          recordBackgroundJob('protocol_scan', 'success', scanDuration)
          logger.info('Daily protocol scan complete', {
            correlationId,
            protocolsScanned: protocols.length,
          })
        } catch (error) {
          logger.error('Daily protocol scan failed', {
            correlationId,
            error: error instanceof Error ? error.message : 'Unknown error',
          })
          recordBackgroundJob('protocol_scan', 'failed', 0)
          await logAgentAction('SCAN', 'FAILED', {
            input: { correlationId },
            error: error instanceof Error ? error.message : 'Unknown error',
          })
        }
      })
    })
    cronJobs.push(scanJob)
    logger.info('✓ Daily protocol scan scheduled: Daily at 2 AM')

    isRunning = true
    logger.info('✅ NeuroWealth Agent Loop started successfully')

    // Setup graceful shutdown
    setupGracefulShutdown()
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error'
    lastError = errorMessage
    // Update Prometheus metrics for error state
    updateAgentStatus('degraded')
    logger.error('Failed to start agent loop', { error: errorMessage })
    throw error
  }
}

/**
 * Stop the agent loop gracefully
 */
export async function stopAgentLoop(): Promise<void> {
  if (!isRunning) {
    logger.warn('Agent loop is not running')
    return
  }

  try {
    logger.info('Stopping NeuroWealth Agent Loop...')

    // Stop all cron jobs. node-cron@3's ScheduledTask exposes stop() only
    // (destroy() was added in v4); stopping and dropping our references is
    // enough for the jobs to be GC'd.
    cronJobs.forEach((job) => {
      job.stop()
    })
    cronJobs.length = 0

    isRunning = false
    logger.info('✅ Agent loop stopped gracefully')
  } catch (error) {
    logger.error('Error stopping agent loop', {
      error: error instanceof Error ? error.message : 'Unknown error',
    })
  }
}

/**
 * Setup graceful shutdown handlers
 */
function setupGracefulShutdown(): void {
  // Handle uncaught exceptions
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception in agent', {
      error: error instanceof Error ? error.message : String(error),
    })
    lastError = error instanceof Error ? error.message : 'Uncaught exception'
  })

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection in agent', {
      reason: reason instanceof Error ? reason.message : String(reason),
    })
    lastError = reason instanceof Error ? reason.message : 'Unhandled rejection'
  })
}

/**
 * Export for testing
 */
export { rebalanceCheckJob, snapshotJob }
