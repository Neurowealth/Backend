#!/usr/bin/env ts-node
/**
 * Backfill / on-demand recompute for performance attribution (#320)
 *
 * Runs computePerformanceAttribution() outside the scheduled interval — for a
 * fresh deploy of the attribution migration (no rows exist yet), for a
 * benchmark-config change (ATTRIBUTION_BENCHMARK_PROTOCOLS), or as a manual
 * repair tool. Idempotent: PortfolioAttribution/StrategyAttribution are
 * upserted on (subject, windowDays), so re-running is always safe.
 *
 * Usage:
 *   npx ts-node scripts/backfill-attribution.ts [--dry-run]
 *
 * Environment:
 *   - Database connection required via DATABASE_URL.
 *   - ATTRIBUTION_BENCHMARK_PROTOCOLS, if set, narrows the benchmark universe
 *     exactly as it would for the scheduled job — see src/config/env.ts.
 */

import db from '../src/db'
import { logger } from '../src/utils/logger'
import { computePerformanceAttribution } from '../src/jobs/attribution'

const DRY_RUN = process.argv.includes('--dry-run')

async function main(): Promise<void> {
  const [userCount, strategyCount] = await Promise.all([
    db.position.findMany({ distinct: ['userId'], select: { userId: true } }),
    db.publishedStrategy.count(),
  ])

  logger.info('[Attribution Backfill] Starting', {
    usersWithPositions: userCount.length,
    publishedStrategies: strategyCount,
    dryRun: DRY_RUN,
  })

  if (DRY_RUN) {
    logger.info('[Attribution Backfill] Dry run — no writes')
    return
  }

  await computePerformanceAttribution()

  logger.info('[Attribution Backfill] Complete')
}

main()
  .catch((err) => {
    logger.error('[Attribution Backfill] Failed', {
      error: err instanceof Error ? err.message : String(err),
    })
    process.exitCode = 1
  })
  .finally(() => db.$disconnect())
