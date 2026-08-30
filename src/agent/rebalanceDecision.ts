/**
 * RebalanceDecision persistence (#343) — the per-decision rationale ledger.
 *
 * `persistRebalanceDecision` is the single writer of `rebalance_decisions`
 * rows. One row per (protocol, strategy, follow) batch evaluation per tick,
 * written whether or not a rebalance fired, so "held" and "blocked" decisions
 * are as visible as "rebalanced" ones.
 *
 * ── Never blocks a rebalance ────────────────────────────────────────────────
 * Persistence is best-effort: a failure logs + alerts and returns null, exactly
 * like the tax-lot pattern in src/stellar/events.ts. The rebalance itself is
 * never rolled back or gated on the ledger write. Decisions are backfillable
 * from the correlation-scoped logs.
 *
 * ── Consecutive HELD collapsing ─────────────────────────────────────────────
 * A batch that holds every tick would otherwise write 24 rows/day/batch.
 * `collapseHeldInto` compares the newest HELD row for the same batchKey on
 * (candidates, thresholds): identical inputs bump `lastEvaluatedAt` and merge
 * `affectedUserIds`; a change in inputs starts a new row.
 *
 * ── Audit-ledger feed (#315) ─────────────────────────────────────────────────
 * Every write emits a canonical payload hash into `audit_payload_hashes`
 * (tableName=rebalance_decisions, kind=REBALANCE_DECISION), so the decision
 * record itself is tamper-evident and feeds the hash-chained audit ledger.
 *
 * ── Real-time stream ─────────────────────────────────────────────────────────
 * On a NEW row (not a collapsed repeat), `agent.decision_recorded` is published
 * to every affected user's stream with the decision id + outcome, so a client
 * can deep-link to the explanation right after `agent.rebalanced`.
 */

import { Prisma } from '@prisma/client'
import db from '../db'
import { logger } from '../utils/logger'
import { alertingService } from '../services/alerting'
import { auditPayloadHashFor, canonicalizeAuditPayload } from '../audit/chain'
import { getCorrelationId } from '../utils/correlation'
import { publishUserEvent } from '../events/publisher'
import { EVENT_TYPE_TOPIC } from '../events/types'
import type {
  DecisionTrace,
  RankedCandidate,
  RebalanceThresholds,
} from './types'

export type RebalanceOutcome = 'REBALANCED' | 'HELD' | 'BLOCKED'

export interface PersistRebalanceDecisionInput {
  /** protocol:strategy:followId from src/agent/loop.ts */
  batchKey: string
  fromProtocol: string
  /** null when the decision was "hold" */
  toProtocol?: string | null
  outcome: RebalanceOutcome
  blockedReason?: string | null
  strategyName?: string | null
  strategyIsFollowed?: boolean
  followedStrategyId?: string | null
  thresholds: RebalanceThresholds
  trace: DecisionTrace
  rationale?: string | null
  affectedUserIds: string[]
  affectedPositions: number
  outboxOpId?: string | null
}

type Db = typeof db | Prisma.TransactionClient

/**
 * Fire-and-forget alert. Alerting must never break the money path, so both
 * synchronous throws and rejected promises are swallowed (mirrors
 * src/tax/service.ts#safeAlert).
 */
function safeAlert(
  payload: Parameters<typeof alertingService.emit>[0],
  dedupeKey: string
): void {
  try {
    void alertingService.emit(payload, dedupeKey).catch(() => {})
  } catch {
    // deliberately ignored
  }
}

/** Format a Decimal(12,6)-bound number for stable audit canonicalization. */
function fmtDecimal(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null
  }
  return Number(value).toFixed(6)
}

/**
 * Canonical plain-object form of a decision for the audit hash (#315). Decimal
 * fields are fixed to 6dp so the hash recomputes identically from the DB row's
 * Decimal(12,6) values.
 */
export function decisionAuditPayload(
  input: PersistRebalanceDecisionInput
): Record<string, unknown> {
  return {
    batchKey: input.batchKey,
    fromProtocol: input.fromProtocol,
    toProtocol: input.toProtocol ?? null,
    outcome: input.outcome,
    blockedReason: input.blockedReason ?? null,
    strategyName: input.strategyName ?? null,
    strategyIsFollowed: input.strategyIsFollowed ?? false,
    followedStrategyId: input.followedStrategyId ?? null,
    thresholds: {
      minimumImprovement: input.thresholds.minimumImprovement,
      maxGasPercent: input.thresholds.maxGasPercent,
    },
    currentApy: fmtDecimal(input.trace.currentApy),
    chosenApy: fmtDecimal(input.trace.chosenApy),
    rawImprovement: fmtDecimal(input.trace.rawImprovement),
    netImprovement: fmtDecimal(input.trace.netImprovement),
    estCostPercent: fmtDecimal(input.trace.estCostPercent),
    candidates: input.trace.candidates ?? [],
    rationale: input.rationale ?? null,
    affectedUserIds: Array.from(new Set(input.affectedUserIds)).sort(),
    affectedPositions: input.affectedPositions,
    outboxOpId: input.outboxOpId ?? null,
  }
}

/**
 * Stable identity string for the HELD-collapse comparison: the inputs that
 * must not change for two consecutive HELD decisions to be "the same decision".
 * Only the candidates ranking and thresholds count — `affectedUserIds` may
 * legitimately differ between ticks without starting a new row.
 */
export function heldDecisionIdentity(
  thresholds: RebalanceThresholds,
  candidates: RankedCandidate[]
): string {
  return canonicalizeAuditPayload({
    thresholds: {
      minimumImprovement: thresholds.minimumImprovement,
      maxGasPercent: thresholds.maxGasPercent,
    },
    candidates,
  })
}

/** Union two userId lists, de-duplicated. */
export function mergeAffectedUserIds(
  existing: string[],
  incoming: string[]
): string[] {
  return Array.from(new Set([...(existing ?? []), ...incoming])).filter(Boolean)
}

interface PersistedDecisionLike {
  id: string
  outcome: string
  thresholds: unknown
  candidates: unknown
  affectedUserIds: string[]
}

/**
 * When the newest HELD row for this batch has the same candidates ranking and
 * thresholds, collapse the new decision into it (bump lastEvaluatedAt, merge
 * affectedUserIds) and return that row. Otherwise return null.
 */
function collapseHeldInto(
  previous: PersistedDecisionLike | null,
  thresholds: RebalanceThresholds,
  candidates: RankedCandidate[]
): PersistedDecisionLike | null {
  if (!previous || previous.outcome !== 'HELD') return null

  const previousIdentity = canonicalizeAuditPayload({
    thresholds: previous.thresholds,
    candidates: previous.candidates,
  })
  const nextIdentity = heldDecisionIdentity(thresholds, candidates)

  if (previousIdentity !== nextIdentity) return null
  return previous
}

/**
 * Persist one rebalance decision. Best-effort: never throws; returns the row id
 * on success and null on failure (logged + alerted, backfillable from logs).
 */
export async function persistRebalanceDecision(
  input: PersistRebalanceDecisionInput,
  database: Db = db
): Promise<string | null> {
  const correlationId = getCorrelationId() ?? input.batchKey
  const now = new Date()

  try {
    const data = {
      correlationId,
      batchKey: input.batchKey,
      fromProtocol: input.fromProtocol,
      toProtocol: input.toProtocol ?? null,
      outcome: input.outcome,
      blockedReason: input.blockedReason ?? null,
      strategyName: input.strategyName ?? null,
      strategyIsFollowed: input.strategyIsFollowed ?? false,
      followedStrategyId: input.followedStrategyId ?? null,
      thresholds: input.thresholds as unknown as Prisma.InputJsonValue,
      currentApy: input.trace.currentApy,
      chosenApy: input.trace.chosenApy,
      rawImprovement: input.trace.rawImprovement,
      estCostPercent: input.trace.estCostPercent,
      netImprovement: input.trace.netImprovement,
      candidates: (input.trace.candidates ??
        []) as unknown as Prisma.InputJsonValue,
      rationale: input.rationale ?? null,
      affectedUserIds: mergeAffectedUserIds([], input.affectedUserIds),
      affectedPositions: input.affectedPositions,
      outboxOpId: input.outboxOpId ?? null,
    }

    let decisionId: string | null = null
    let isNewRow = false

    if (input.outcome === 'HELD') {
      const previous = (await (database as any).rebalanceDecision.findFirst({
        where: { batchKey: input.batchKey, outcome: 'HELD' },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          outcome: true,
          thresholds: true,
          candidates: true,
          affectedUserIds: true,
        },
      })) as PersistedDecisionLike | null

      const collapsed = collapseHeldInto(
        previous,
        input.thresholds,
        input.trace.candidates
      )

      if (collapsed) {
        await (database as any).rebalanceDecision.update({
          where: { id: collapsed.id },
          data: {
            lastEvaluatedAt: now,
            affectedPositions: input.affectedPositions,
            affectedUserIds: mergeAffectedUserIds(
              collapsed.affectedUserIds,
              input.affectedUserIds
            ),
          },
        })
        decisionId = collapsed.id
      }
    }

    if (!decisionId) {
      isNewRow = true
      const created = (await (database as any).rebalanceDecision.create({
        data: {
          ...data,
          heldSince: input.outcome === 'HELD' ? now : null,
          lastEvaluatedAt: input.outcome === 'HELD' ? now : null,
        },
      })) as { id: string }
      decisionId = created.id
    }

    // Audit-ledger feed (#315): every NEW decision record is tamper-evident.
    // A collapsed HELD repeat is the same record continuing, not a new one.
    if (isNewRow) {
      try {
        await (database as any).auditPayloadHash.create({
          data: {
            tableName: 'rebalance_decisions',
            kind: 'REBALANCE_DECISION',
            payloadHash: auditPayloadHashFor(decisionAuditPayload(input)),
          },
        })
      } catch (auditError) {
        logger.error('[DecisionLedger] Audit hash feed failed (non-fatal)', {
          error:
            auditError instanceof Error
              ? auditError.message
              : String(auditError),
          batchKey: input.batchKey,
        })
      }

      // Real-time stream: on the same NEW row, so a client can deep-link to the
      // explanation right after `agent.rebalanced`.
      try {
        await publishUserEvent(
          input.affectedUserIds,
          EVENT_TYPE_TOPIC['agent.decision_recorded'],
          'agent.decision_recorded',
          {
            decisionId,
            outcome: input.outcome,
            fromProtocol: input.fromProtocol,
            toProtocol: input.toProtocol ?? null,
            blockedReason: input.blockedReason ?? null,
            createdAt: now.toISOString(),
          }
        ).catch(() => {})
      } catch (publishError) {
        // publishUserEvent already never throws; guard for safety.
        logger.warn('[DecisionLedger] Decision event publish failed', {
          error:
            publishError instanceof Error
              ? publishError.message
              : String(publishError),
        })
      }
    }

    logger.info('[DecisionLedger] Rebalance decision recorded', {
      decisionId,
      batchKey: input.batchKey,
      outcome: input.outcome,
      blockedReason: input.blockedReason ?? null,
      isNewRow,
      correlationId,
    })

    return decisionId
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error('[DecisionLedger] Rebalance decision persistence failed', {
      batchKey: input.batchKey,
      outcome: input.outcome,
      fromProtocol: input.fromProtocol,
      error: message,
      correlationId,
    })
    safeAlert(
      {
        title: 'Rebalance decision persistence failed',
        description: `Writing the RebalanceDecision row for batch ${input.batchKey} (${input.outcome}) failed: ${message}. The rebalance is unaffected; the decision is backfillable from the correlation-scoped logs.`,
        severity: 'warning',
        component: 'agent-decision-ledger',
        metadata: {
          batchKey: input.batchKey,
          outcome: input.outcome,
          fromProtocol: input.fromProtocol,
          correlationId,
        },
      },
      `agent:decision-persist:${input.batchKey}:${input.outcome}`
    )
    return null
  }
}
