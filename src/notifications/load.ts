/**
 * Digest data loading (#365).
 *
 * Fetches the raw portfolio inputs for a user over a period from the DB and
 * hands them to the pure `buildDigest` assembler. Used by both the scheduled
 * job (`src/jobs/digests.ts`) and the preview endpoint. Nothing here renders or
 * delivers — it only assembles inputs.
 */

import db from '../db'
import { computeGoalProgress } from '../goals/service'
import type { DigestInput, DigestFrequency } from './digest'

export function periodFromFrequency(
  frequency: DigestFrequency,
  now: Date = new Date()
): { label: string; startAt: Date; endAt: Date } {
  const endAt = new Date(now)
  const startAt = new Date(now)
  switch (frequency) {
    case 'DAILY':
      startAt.setUTCDate(startAt.getUTCDate() - 1)
      return { label: 'Past 24 hours', startAt, endAt }
    case 'WEEKLY':
      startAt.setUTCDate(startAt.getUTCDate() - 7)
      return { label: 'Past 7 days', startAt, endAt }
    case 'MONTHLY':
      startAt.setUTCMonth(startAt.getUTCMonth() - 1)
      return { label: 'Past 30 days', startAt, endAt }
  }
}

/**
 * Assemble a `DigestInput` for one user by querying their positions, snapshots,
 * transactions, rebalances and goals over the period. Owner-scoped: everything
 * is filtered by `userId`.
 */
export async function loadDigestData(
  userId: string,
  frequency: DigestFrequency,
  now: Date = new Date(),
  notableTxnThreshold = 100
): Promise<DigestInput> {
  const period = periodFromFrequency(frequency, now)

  const [positions, goalRows] = await Promise.all([
    db.position.findMany({
      where: { userId, status: 'ACTIVE' },
      select: {
        id: true,
        protocolName: true,
        assetSymbol: true,
        currentValue: true,
        depositedAmount: true,
        yieldEarned: true,
      },
    }),
    db.savingsGoal.findMany({
      where: { userId, status: 'ACTIVE' },
      select: { id: true, targetAmount: true },
    }),
  ])

  const snapshots =
    positions.length === 0
      ? []
      : await db.yieldSnapshot.findMany({
          where: {
            positionId: { in: positions.map((p) => p.id) },
            snapshotAt: { gte: period.startAt },
          },
          select: {
            positionId: true,
            apy: true,
            principalAmount: true,
            yieldAmount: true,
            snapshotAt: true,
          },
        })

  const transactionRows =
    positions.length === 0
      ? []
      : await db.transaction.findMany({
          where: {
            userId,
            createdAt: { gte: period.startAt },
            status: 'CONFIRMED',
          },
          select: {
            type: true,
            amount: true,
            assetSymbol: true,
            createdAt: true,
          },
        })

  const rebalances =
    positions.length === 0
      ? []
      : await db.rebalanceDecision.findMany({
          where: {
            affectedUserIds: { has: userId },
            outcome: 'REBALANCED',
            createdAt: { gte: period.startAt },
          },
          select: {
            fromProtocol: true,
            toProtocol: true,
            netImprovement: true,
            createdAt: true,
          },
        })

  // Goal progress uses the goal service so `onTrack`/progress are computed
  // with the same APY reachability logic the platform shows in-app. A null
  // `progressPctStart` is honest: we don't persist historical goal progress,
  // so a period delta is not fabricated.
  const goals: DigestInput['goals'] = []
  for (const g of goalRows) {
    const target = Number(g.targetAmount)
    try {
      const progress = await computeGoalProgress(g.id)
      goals.push({
        name: null,
        targetAmount: target,
        progressPctStart: null,
        progressPctNow:
          target > 0 ? (progress.currentAmount / target) * 100 : 0,
        onTrack: progress.onTrack,
        currentAmount: progress.currentAmount,
      })
    } catch {
      // A single goal's progress failure must not abort the whole digest.
      goals.push({
        name: null,
        targetAmount: target,
        progressPctStart: null,
        progressPctNow: null,
        onTrack: false,
        currentAmount: 0,
      })
    }
  }

  // netImprovement is stored as a fraction (0.0123 == +1.23%).
  const rebalanceInput = rebalances.map((r) => ({
    fromProtocol: r.fromProtocol,
    toProtocol: r.toProtocol,
    improvedByPercent:
      r.netImprovement === null ? null : Number(r.netImprovement) * 100,
    createdAt: r.createdAt,
  }))

  return {
    period,
    positions: positions.map((p) => ({
      id: p.id,
      protocolName: p.protocolName,
      assetSymbol: p.assetSymbol,
      currentValue: Number(p.currentValue),
      depositedAmount: Number(p.depositedAmount),
      yieldEarned: Number(p.yieldEarned),
    })),
    snapshots: snapshots.map((s) => ({
      positionId: s.positionId,
      value: Number(s.principalAmount) + Number(s.yieldAmount),
      apy: Number(s.apy),
      timestampMs: s.snapshotAt.getTime(),
    })),
    transactions: transactionRows.map((t) => ({
      type: t.type,
      amount: Number(t.amount),
      assetSymbol: t.assetSymbol,
      createdAt: t.createdAt,
    })),
    rebalances: rebalanceInput,
    goals,
    caveats: [],
    notableTxnThreshold,
  }
}
