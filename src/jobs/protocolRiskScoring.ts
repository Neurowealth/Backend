import db from '../db'
import { logger, logBackgroundJob } from '../utils/logger'
import {
  generateCorrelationId,
  runWithCorrelationIdAsync,
} from '../utils/correlation'
import { config } from '../config/env'
import { recordJobSuccess, recordJobFailure } from '../utils/job-metrics'
import { computeRiskScore, RateSample } from '../agent/riskScoring'
import { PROTOCOL_RISK_METADATA } from '../config/protocolRiskMetadata'

/**
 * Protocol risk scoring job.
 *
 * Recomputes each protocol's risk score from its ProtocolRate history plus the
 * curated audit/age metadata, and upserts the result into ProtocolRiskScore.
 * Scoring math lives in src/agent/riskScoring.ts (pure + unit-tested); this job
 * is only the DB glue and scheduling, mirroring the other jobs in src/jobs/.
 *
 * The set of protocols to score is the union of everything seen in rate history
 * and everything in the curated metadata table, so a curated-but-not-yet-scanned
 * protocol still gets a (conservative) score, and a scanned-but-uncurated one is
 * scored with the conservative UNAUDITED/unknown-age default.
 */
export async function computeProtocolRiskScores(
  now: Date = new Date()
): Promise<void> {
  const correlationId = generateCorrelationId()
  return runWithCorrelationIdAsync(correlationId, async () => {
    const start = Date.now()
    const jobName = 'protocol_risk_scoring'

    try {
      // Distinct protocol names from rate history…
      const rateProtocols = await db.protocolRate.findMany({
        distinct: ['protocolName'],
        select: { protocolName: true },
      })

      const protocolNames = new Set<string>([
        ...rateProtocols.map((r: { protocolName: string }) => r.protocolName),
        ...PROTOCOL_RISK_METADATA.map((m) => m.protocolName),
      ])

      let scored = 0
      for (const protocolName of protocolNames) {
        const rates = await db.protocolRate.findMany({
          where: { protocolName },
          orderBy: { fetchedAt: 'asc' },
          select: { supplyApy: true, tvl: true, fetchedAt: true },
        })

        const samples: RateSample[] = rates.map(
          (r: { supplyApy: unknown; tvl: unknown; fetchedAt: Date }) => ({
            supplyApy: Number(r.supplyApy),
            tvl: r.tvl === null || r.tvl === undefined ? null : Number(r.tvl),
            fetchedAt: r.fetchedAt,
          })
        )

        const result = computeRiskScore(protocolName, samples, now)

        await db.protocolRiskScore.upsert({
          where: { protocolName },
          create: {
            protocolName,
            score: result.score,
            tvlTrendFactor: result.tvlTrendFactor,
            apyVolatilityFactor: result.apyVolatilityFactor,
            auditStatus: result.auditStatus,
            protocolAgeDays: result.protocolAgeDays,
            insufficientHistory: result.insufficientHistory,
            sampleCount: result.sampleCount,
            computedAt: now,
          },
          update: {
            score: result.score,
            tvlTrendFactor: result.tvlTrendFactor,
            apyVolatilityFactor: result.apyVolatilityFactor,
            auditStatus: result.auditStatus,
            protocolAgeDays: result.protocolAgeDays,
            insufficientHistory: result.insufficientHistory,
            sampleCount: result.sampleCount,
            computedAt: now,
          },
        })
        scored++
      }

      const durationMs = Date.now() - start
      logBackgroundJob(jobName, 'success', durationMs / 1000, correlationId, {
        protocolsScored: scored,
      })
      recordJobSuccess(jobName, durationMs)
    } catch (error) {
      const durationMs = Date.now() - start
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error'

      logBackgroundJob(jobName, 'failed', durationMs / 1000, correlationId, {
        error: errorMessage,
      })
      recordJobFailure(jobName, durationMs)
    }
  })
}

/**
 * Schedule the risk-scoring job. Runs once on startup then on the configured
 * interval (default 6 h), following the same pattern as the other jobs.
 *
 * @returns NodeJS.Timeout handle — pass to clearInterval() on shutdown.
 */
export function scheduleProtocolRiskScoring(): NodeJS.Timeout {
  void computeProtocolRiskScores()

  const intervalMs = config.protocolRisk.intervalMs
  const handle = setInterval(() => {
    void computeProtocolRiskScores()
  }, intervalMs)

  handle.unref?.()

  logger.info(
    `[ProtocolRiskScoring] Risk scoring scheduled every ${intervalMs / 3600000}h`
  )
  return handle
}
