/**
 * Staleness check for ProtocolRiskMetadataEntry (#529, #621). Flags entries
 * past their review-due date and pages via the alerting service (PagerDuty
 * when PAGERDUTY_ROUTING_KEY is set); optionally auto-downgrades
 * dataConfidence toward UNVERIFIED when config.protocolRisk.staleAutoDowngrade
 * is set (default off — flag-only, never silently alters a reviewed status).
 * Scores of stale protocols are degraded visibly — see applyStalenessPenalty.
 */
import db from '../db'
import { logger } from '../utils/logger'
import { config } from '../config/env'
import { alertingService } from '../services/alerting'
import { riskMetadataStaleEntries } from '../utils/metrics'
import { scheduleResilientJob } from './resilientScheduler'

export async function flagStaleEntries(
  now: Date = new Date()
): Promise<string[]> {
  const stale = await db.protocolRiskMetadataEntry.findMany({
    where: { nextReviewDueAt: { lt: now } },
    select: { protocolName: true, id: true },
  })

  riskMetadataStaleEntries.set(stale.length)

  if (stale.length === 0) return []

  const protocols = stale.map((s) => s.protocolName)

  logger.warn('[RiskMetadataStaleness] Entries past review-due date', {
    protocols,
  })

  await alertingService.emit(
    {
      title: 'Protocol risk metadata is stale',
      description: `Risk metadata past its review-due date for: ${protocols.join(', ')}`,
      severity: 'critical',
      component: 'protocol-risk-metadata',
      metadata: { protocols },
      dedupKey: 'risk-metadata-stale',
    },
    'risk-metadata-stale'
  )

  if (config.protocolRisk.staleAutoDowngrade) {
    await db.protocolRiskMetadataEntry.updateMany({
      where: { id: { in: stale.map((s) => s.id) } },
      data: { dataConfidence: 'UNVERIFIED' },
    })
  }

  return protocols
}

export async function getStaleProtocolNames(
  now: Date = new Date()
): Promise<Set<string>> {
  const stale = await db.protocolRiskMetadataEntry.findMany({
    where: { nextReviewDueAt: { lt: now } },
    select: { protocolName: true },
  })
  return new Set(stale.map((s) => s.protocolName))
}

/** Lowers a score by the configured penalty (floor 0) when metadata is stale. */
export function applyStalenessPenalty(score: number, stale: boolean): number {
  if (!stale) return score
  return Math.max(0, score - config.protocolRisk.stalePenalty)
}

export function scheduleRiskMetadataStaleness(): NodeJS.Timeout {
  return scheduleResilientJob({
    jobName: 'risk_metadata_staleness',
    task: () => flagStaleEntries().then(() => undefined),
    intervalMs: config.protocolRisk.stalenessIntervalMs,
    unref: true,
  })
}
