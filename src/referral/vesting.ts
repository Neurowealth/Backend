/**
 * Referral Reward Vesting & Early-Withdrawal Clawback (#364).
 *
 * Splits referral rewards into scheduled vesting tranches (`ReferralRewardTranche`)
 * tied to the referred user maintaining `requiresBalanceAtLeast` across `M`
 * consecutive balance snapshots (`YieldSnapshot` / `Position`), and records
 * non-custodial `ReferralClawback` offsets against future referrer rewards when
 * a referred user withdraws early after an initial tranche has been paid.
 */
import { Decimal } from '@prisma/client/runtime/library'
import {
  Network,
  ReferralStatus,
  TransactionStatus,
  TransactionType,
} from '@prisma/client'
import db from '../db'
import { config } from '../config'
import { logger } from '../utils/logger'
import { auditPayloadHashFor } from '../audit/chain'
import { publishUserEvent } from '../events/publisher'
import { EVENT_TYPE_TOPIC } from '../events/types'
import { enqueueOutboxOp } from '../outbox/service'
import { dispatchOne } from '../outbox/dispatcher'
import { deriveIdempotencyKey } from '../outbox/idempotency'
import { getWalletByUserId } from '../stellar/wallet'

export const REFERRAL_VESTING_DISCLOSURE_COPY =
  'Rewards vest over 90 days while your friend keeps their deposit.'

export type TrancheLeg = 'referrer' | 'referred'
export type TrancheStatus =
  | 'PENDING'
  | 'VESTED_PAID'
  | 'FORFEITED'
  | 'CLAWED_BACK'
export type ClawbackStatus = 'OPEN' | 'OFFSET_COMPLETE' | 'WRITTEN_OFF'

export interface PlannedVestingTranche {
  conversionId: string
  leg: TrancheLeg
  seq: number
  amount: Decimal
  vestsAt: Date
  status: TrancheStatus
  requiresBalanceAtLeast: Decimal
}

const TERMINAL_TRANCHE_STATUSES = new Set<string>([
  'VESTED_PAID',
  'FORFEITED',
  'CLAWED_BACK',
])

export function isTerminalTrancheStatus(status: string): boolean {
  return TERMINAL_TRANCHE_STATUSES.has(status)
}

async function writeAuditHash(
  database: any,
  tableName: string,
  kind: string,
  payload: Record<string, unknown>
): Promise<string> {
  const payloadHash = auditPayloadHashFor(payload)
  try {
    await database.auditPayloadHash?.create?.({
      data: {
        tableName,
        kind,
        payloadHash,
      },
    })
  } catch (err) {
    logger.warn('[ReferralVesting] Failed to write audit hash (non-fatal)', {
      kind,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  return payloadHash
}

/**
 * Split total referrer and referred rewards into `N` vesting tranches with
 * deterministic 8-decimal rounding (any residual penny/unit lands on the final
 * tranche so the sum of tranches equals the exact leg total).
 */
export function buildVestingTrancheSchedule(params: {
  conversionId: string
  activatedAt: Date
  ownerRewardTotal: number
  referredRewardTotal: number
  requiresBalanceAtLeast?: number
  trancheCount?: number
  scheduleDays?: number[]
}): PlannedVestingTranche[] {
  const trancheCount = Math.max(
    1,
    params.trancheCount ?? config.referral.vestingTranches ?? 3
  )
  const rawScheduleDays =
    params.scheduleDays && params.scheduleDays.length > 0
      ? params.scheduleDays
      : config.referral.vestingScheduleDays &&
          config.referral.vestingScheduleDays.length > 0
        ? config.referral.vestingScheduleDays
        : [0, 30, 90]

  const scheduleDays: number[] = []
  for (let i = 0; i < trancheCount; i++) {
    if (i < rawScheduleDays.length) {
      scheduleDays.push(rawScheduleDays[i])
    } else {
      const prev = scheduleDays[i - 1] ?? 0
      scheduleDays.push(prev + 30)
    }
  }

  const minBalance = new Decimal(
    params.requiresBalanceAtLeast ?? config.referral.minActivationDeposit ?? 10
  )

  const legs: Array<{ leg: TrancheLeg; total: number }> = [
    { leg: 'referrer', total: params.ownerRewardTotal },
    { leg: 'referred', total: params.referredRewardTotal },
  ]

  const tranches: PlannedVestingTranche[] = []

  for (const { leg, total } of legs) {
    if (total <= 0) continue

    const totalDec = new Decimal(total)
    const baseSlice = new Decimal(
      totalDec.dividedBy(trancheCount).toFixed(8, Decimal.ROUND_DOWN)
    )
    let allocated = new Decimal(0)

    for (let idx = 0; idx < trancheCount; idx++) {
      const seq = idx + 1
      const isLast = seq === trancheCount
      const amount = isLast ? totalDec.minus(allocated) : baseSlice
      allocated = allocated.plus(amount)

      const vestsAt = new Date(
        params.activatedAt.getTime() + scheduleDays[idx] * 86_400_000
      )

      tranches.push({
        conversionId: params.conversionId,
        leg,
        seq,
        amount,
        vestsAt,
        status: 'PENDING',
        requiresBalanceAtLeast: minBalance,
      })
    }
  }

  return tranches
}

/**
 * Evaluate whether the referred user's deposited balance meets
 * `requiresBalanceAtLeast` at `vestsAt`, with a consecutive-snapshot guard (`M`
 * snapshots) so a single transient dip during a rebalance in flight never
 * forfeits a legitimate referrer's tranche.
 *
 * Privacy invariant: callers must never expose `observedBalances` to the
 * referrer; only `meetsThreshold` and the high-level status are surfaced.
 */
export async function evaluateReferredBalanceCheckpoint(params: {
  referredUserId: string
  requiresBalanceAtLeast: Decimal | number | string
  vestsAt: Date
  now?: Date
  graceHours?: number
  requiredConsecutiveSnapshots?: number
  database?: any
}): Promise<{
  meetsThreshold: boolean
  sustainedDrop: boolean
  consecutiveBelowCount: number
  reason: string | null
}> {
  const database = params.database ?? db
  const threshold = new Decimal(params.requiresBalanceAtLeast)
  const requiredM = Math.max(
    1,
    params.requiredConsecutiveSnapshots ??
      config.referral.vestingConsecutiveSnapshots ??
      3
  )
  const graceHours =
    params.graceHours ?? config.referral.vestingGraceHours ?? 6
  const upperBound = new Date(
    Math.max(
      params.vestsAt.getTime() + graceHours * 3600_000,
      (params.now ?? new Date()).getTime()
    )
  )

  // 1. Check recent YieldSnapshot observations for the user's positions up to upperBound
  let snapshotTotals: number[] = []
  try {
    const snapshots = await database.yieldSnapshot?.findMany?.({
      where: {
        position: { userId: params.referredUserId },
        timestamp: { lte: upperBound },
      },
      orderBy: { timestamp: 'desc' },
      take: requiredM * 5,
      select: {
        timestamp: true,
        principalAmount: true,
        yieldAmount: true,
      },
    })

    if (Array.isArray(snapshots) && snapshots.length > 0) {
      // Group snapshots by hour bucket (or exact timestamp) and order newest-first
      const byBucket = new Map<string, Decimal>()
      for (const s of snapshots) {
        const ts =
          s.timestamp instanceof Date
            ? s.timestamp.toISOString().slice(0, 13)
            : String(s.timestamp ?? '')
        const val = new Decimal(s.principalAmount ?? 0).plus(
          new Decimal(s.yieldAmount ?? 0)
        )
        byBucket.set(ts, (byBucket.get(ts) ?? new Decimal(0)).plus(val))
      }
      snapshotTotals = [...byBucket.values()]
        .slice(0, requiredM)
        .map((d) => d.toNumber())
    }
  } catch {
    snapshotTotals = []
  }

  // If we have snapshot observations, count consecutive latest snapshots below threshold
  if (snapshotTotals.length > 0) {
    let consecutiveBelow = 0
    for (const bal of snapshotTotals) {
      if (new Decimal(bal).lessThan(threshold)) {
        consecutiveBelow++
      } else {
        break
      }
    }

    // If the user dipped in 1..M-1 snapshots (e.g., transient rebalance dip) OR
    // withdrew earlier and re-deposited before vestsAt so the latest snapshot
    // is >= threshold, the tranche is NOT forfeited.
    const sustainedDrop =
      consecutiveBelow >= requiredM ||
      (snapshotTotals.length < requiredM &&
        consecutiveBelow === snapshotTotals.length)

    if (sustainedDrop) {
      return {
        meetsThreshold: false,
        sustainedDrop: true,
        consecutiveBelowCount: consecutiveBelow,
        reason: 'INSUFFICIENT_DEPOSITED_BALANCE_AT_CHECKPOINT',
      }
    }

    return {
      meetsThreshold: true,
      sustainedDrop: false,
      consecutiveBelowCount: consecutiveBelow,
      reason: null,
    }
  }

  // 2. Fallback when no YieldSnapshot rows exist: sum live ACTIVE Position rows
  let liveBalance = new Decimal(0)
  try {
    const positions = await database.position?.findMany?.({
      where: {
        userId: params.referredUserId,
        status: 'ACTIVE',
      },
      select: {
        depositedAmount: true,
        yieldEarned: true,
      },
    })
    if (Array.isArray(positions)) {
      for (const p of positions) {
        liveBalance = liveBalance
          .plus(new Decimal(p.depositedAmount ?? 0))
          .plus(new Decimal(p.yieldEarned ?? 0))
      }
    }
  } catch {}

  if (liveBalance.greaterThanOrEqualTo(threshold)) {
    return {
      meetsThreshold: true,
      sustainedDrop: false,
      consecutiveBelowCount: 0,
      reason: null,
    }
  }

  return {
    meetsThreshold: false,
    sustainedDrop: true,
    consecutiveBelowCount: requiredM,
    reason: 'INSUFFICIENT_DEPOSITED_BALANCE_AT_CHECKPOINT',
  }
}

/**
 * Expire OPEN clawback records past `expiresAt` (`CLAWBACK_WRITEOFF_DAYS`),
 * transitioning them to `WRITTEN_OFF` and recording a #315 audit entry.
 */
export async function expireStaleClawbacks(
  now: Date = new Date(),
  database: any = db
): Promise<number> {
  const stale = await database.referralClawback?.findMany?.({
    where: {
      status: 'OPEN',
      expiresAt: { lte: now },
    },
  })
  if (!Array.isArray(stale) || stale.length === 0) return 0

  let writtenOffCount = 0
  for (const row of stale) {
    const remaining = new Decimal(row.remainingAmount ?? 0)
    await database.referralClawback.update({
      where: { id: row.id },
      data: {
        status: 'WRITTEN_OFF',
        writtenOffAmount: new Decimal(row.writtenOffAmount ?? 0).plus(
          remaining
        ),
        remainingAmount: new Decimal(0),
        resolvedAt: now,
      },
    })
    await writeAuditHash(
      database,
      'referral_clawbacks',
      'REFERRAL_CLAWBACK_WRITTEN_OFF',
      {
        clawbackId: row.id,
        referrerUserId: row.referrerUserId,
        conversionId: row.conversionId,
        writtenOffAmount: remaining.toString(),
        resolvedAt: now.toISOString(),
      }
    )
    writtenOffCount++
  }

  return writtenOffCount
}

/**
 * Apply any OPEN `ReferralClawback` balance for `referrerUserId` as a
 * non-custodial offset against an upcoming referrer reward tranche.
 * Never pulls on-chain from a user wallet and never produces a negative payout.
 */
export async function applyClawbackOffsetToReward(params: {
  referrerUserId: string
  grossRewardAmount: Decimal | number | string
  conversionId: string
  trancheId: string
  now?: Date
  database?: any
}): Promise<{
  netPayableAmount: number
  offsetAmount: number
  affectedClawbackIds: string[]
}> {
  const database = params.database ?? db
  const now = params.now ?? new Date()
  await expireStaleClawbacks(now, database)

  let remainingReward = new Decimal(params.grossRewardAmount)
  let totalOffset = new Decimal(0)
  const affectedClawbackIds: string[] = []

  const openClawbacks = await database.referralClawback?.findMany?.({
    where: {
      referrerUserId: params.referrerUserId,
      status: 'OPEN',
      expiresAt: { gt: now },
    },
    orderBy: { createdAt: 'asc' },
  })

  if (!Array.isArray(openClawbacks) || openClawbacks.length === 0) {
    return {
      netPayableAmount: Number(remainingReward.toFixed(8)),
      offsetAmount: 0,
      affectedClawbackIds: [],
    }
  }

  for (const cb of openClawbacks) {
    if (remainingReward.lessThanOrEqualTo(0)) break
    const cbRemaining = new Decimal(cb.remainingAmount ?? 0)
    if (cbRemaining.lessThanOrEqualTo(0)) continue

    const deduction = Decimal.min(remainingReward, cbRemaining)
    const nextCbRemaining = cbRemaining.minus(deduction)
    const nextOffsetApplied = new Decimal(cb.offsetApplied ?? 0).plus(deduction)
    const nextStatus: ClawbackStatus = nextCbRemaining.lessThanOrEqualTo(0)
      ? 'OFFSET_COMPLETE'
      : 'OPEN'

    await database.referralClawback.update({
      where: { id: cb.id },
      data: {
        remainingAmount: nextCbRemaining,
        offsetApplied: nextOffsetApplied,
        status: nextStatus,
        resolvedAt: nextStatus === 'OFFSET_COMPLETE' ? now : null,
      },
    })

    await writeAuditHash(
      database,
      'referral_clawbacks',
      'REFERRAL_CLAWBACK_OFFSET',
      {
        clawbackId: cb.id,
        referrerUserId: params.referrerUserId,
        targetConversionId: params.conversionId,
        targetTrancheId: params.trancheId,
        offsetDeducted: deduction.toString(),
        remainingClawback: nextCbRemaining.toString(),
        status: nextStatus,
        timestamp: now.toISOString(),
      }
    )

    remainingReward = remainingReward.minus(deduction)
    totalOffset = totalOffset.plus(deduction)
    affectedClawbackIds.push(cb.id)
  }

  return {
    netPayableAmount: Number(remainingReward.toFixed(8)),
    offsetAmount: Number(totalOffset.toFixed(8)),
    affectedClawbackIds,
  }
}

/**
 * Record a clawback for already-paid referrer tranche(s) when the referred
 * user's balance drops below threshold before the conversion's vesting period
 * completes (or when a conversion is denied by Sybil review after tranche 1
 * was paid). Also forfeits all remaining `PENDING` tranches for that conversion.
 */
export async function recordEarlyWithdrawalClawback(params: {
  conversionId: string
  referrerUserId: string
  reason: string
  now?: Date
  database?: any
}): Promise<{
  clawbackCreated: boolean
  clawbackId: string | null
  clawedBackAmount: number
  writtenOffAmount: number
  forfeitedTrancheCount: number
}> {
  const database = params.database ?? db
  const now = params.now ?? new Date()

  const tranches = await database.referralRewardTranche?.findMany?.({
    where: { conversionId: params.conversionId },
    orderBy: { seq: 'asc' },
  })
  if (!Array.isArray(tranches) || tranches.length === 0) {
    return {
      clawbackCreated: false,
      clawbackId: null,
      clawedBackAmount: 0,
      writtenOffAmount: 0,
      forfeitedTrancheCount: 0,
    }
  }

  // 1. Forfeit all remaining PENDING tranches
  const pendingTranches = tranches.filter((t: any) => t.status === 'PENDING')
  for (const pt of pendingTranches) {
    await database.referralRewardTranche.update({
      where: { id: pt.id },
      data: {
        status: 'FORFEITED',
        forfeitReason: params.reason,
        evaluatedAt: now,
      },
    })
    await writeAuditHash(
      database,
      'referral_reward_tranches',
      'REFERRAL_TRANCHE_FORFEITED',
      {
        trancheId: pt.id,
        conversionId: params.conversionId,
        leg: pt.leg,
        seq: pt.seq,
        amount: String(pt.amount),
        reason: params.reason,
        evaluatedAt: now.toISOString(),
      }
    )
    if (pt.leg === 'referrer') {
      await publishUserEvent(
        params.referrerUserId,
        EVENT_TYPE_TOPIC['referral.tranche_forfeited'],
        'referral.tranche_forfeited',
        {
          conversionId: params.conversionId,
          trancheId: pt.id,
          leg: pt.leg,
          seq: pt.seq,
          amount: Number(pt.amount),
          reason: params.reason,
          forfeitedAt: now.toISOString(),
        }
      ).catch(() => {})
    }
  }

  // 2. Identify already-paid referrer tranches to claw back
  const paidReferrerTranches = tranches.filter(
    (t: any) => t.leg === 'referrer' && t.status === 'VESTED_PAID'
  )
  if (paidReferrerTranches.length === 0) {
    return {
      clawbackCreated: false,
      clawbackId: null,
      clawedBackAmount: 0,
      writtenOffAmount: 0,
      forfeitedTrancheCount: pendingTranches.length,
    }
  }

  let rawClawbackTotal = new Decimal(0)
  for (const paidTranche of paidReferrerTranches) {
    rawClawbackTotal = rawClawbackTotal.plus(new Decimal(paidTranche.amount))
    await database.referralRewardTranche.update({
      where: { id: paidTranche.id },
      data: {
        status: 'CLAWED_BACK',
        forfeitReason: params.reason,
        evaluatedAt: now,
      },
    })
  }

  // Enforce per-referrer open clawback cap (`CLAWBACK_MAX_PER_REFERRER`)
  const maxPerReferrer = new Decimal(
    config.referral.clawbackMaxPerReferrer ?? 200
  )
  const existingOpen = await database.referralClawback?.findMany?.({
    where: {
      referrerUserId: params.referrerUserId,
      status: 'OPEN',
    },
    select: { remainingAmount: true },
  })
  const currentOpenSum = Array.isArray(existingOpen)
    ? existingOpen.reduce(
        (acc: Decimal, r: any) => acc.plus(new Decimal(r.remainingAmount ?? 0)),
        new Decimal(0)
      )
    : new Decimal(0)

  const capRoom = Decimal.max(new Decimal(0), maxPerReferrer.minus(currentOpenSum))
  const collectibleAmount = Decimal.min(rawClawbackTotal, capRoom)
  const immediateWriteOff = rawClawbackTotal.minus(collectibleAmount)
  const writeoffDays = config.referral.clawbackWriteoffDays ?? 90
  const expiresAt = new Date(now.getTime() + writeoffDays * 86_400_000)
  const initialStatus: ClawbackStatus = collectibleAmount.greaterThan(0)
    ? 'OPEN'
    : 'WRITTEN_OFF'

  const createdClawback = await database.referralClawback.create({
    data: {
      referrerUserId: params.referrerUserId,
      conversionId: params.conversionId,
      trancheId: paidReferrerTranches[0].id,
      originalAmount: rawClawbackTotal,
      remainingAmount: collectibleAmount,
      offsetApplied: new Decimal(0),
      writtenOffAmount: immediateWriteOff,
      status: initialStatus,
      reason: params.reason,
      expiresAt,
      resolvedAt: initialStatus === 'WRITTEN_OFF' ? now : null,
    },
  })

  await writeAuditHash(
    database,
    'referral_clawbacks',
    'REFERRAL_CLAWBACK_CREATED',
    {
      clawbackId: createdClawback.id,
      conversionId: params.conversionId,
      referrerUserId: params.referrerUserId,
      originalAmount: rawClawbackTotal.toString(),
      remainingAmount: collectibleAmount.toString(),
      writtenOffAmount: immediateWriteOff.toString(),
      status: initialStatus,
      reason: params.reason,
      expiresAt: expiresAt.toISOString(),
    }
  )

  await publishUserEvent(
    params.referrerUserId,
    EVENT_TYPE_TOPIC['referral.clawback_recorded'],
    'referral.clawback_recorded',
    {
      conversionId: params.conversionId,
      clawbackId: createdClawback.id,
      originalAmount: rawClawbackTotal.toNumber(),
      remainingAmount: collectibleAmount.toNumber(),
      reason: params.reason,
      createdAt: now.toISOString(),
    }
  ).catch(() => {})

  return {
    clawbackCreated: true,
    clawbackId: createdClawback.id,
    clawedBackAmount: collectibleAmount.toNumber(),
    writtenOffAmount: immediateWriteOff.toNumber(),
    forfeitedTrancheCount: pendingTranches.length,
  }
}

async function resolveTrancheRecipientAddress(
  userId: string,
  database: any
): Promise<string | null> {
  const wallet = await getWalletByUserId(userId)
  if (wallet?.publicKey) return wallet.publicKey
  const user = await database.user?.findUnique?.({ where: { id: userId } })
  return user?.walletAddress ?? null
}

/**
 * Pay a single vesting tranche through the durable outbox with idempotency key
 * `REFERRAL_REWARD:<recipientUserId>:<conversionId>:<leg>:seq:<seq>`.
 * Never marks a tranche `VESTED_PAID` without a confirmed `paidTxHash`.
 */
async function payVestingTrancheOnChain(params: {
  tranche: any
  recipientUserId: string
  amount: number
  network: Network
  database: any
}): Promise<{
  confirmed: boolean
  txHash: string | null
  rewardTxId: string
  outboxOpId: string
}> {
  const { tranche, recipientUserId, amount, network, database } = params
  const address = await resolveTrancheRecipientAddress(
    recipientUserId,
    database
  )
  if (!address) {
    throw new Error(`No wallet address for reward recipient ${recipientUserId}`)
  }

  const asset = config.referral.rewardAsset
  const idempotencyKey = deriveIdempotencyKey(
    'REFERRAL_REWARD',
    recipientUserId,
    `${tranche.conversionId}:${tranche.leg}:seq:${tranche.seq}`
  )

  const pending = await database.$transaction(async (tx: any) => {
    const transaction = await tx.transaction.create({
      data: {
        userId: recipientUserId,
        type: TransactionType.REFERRAL_REWARD,
        status: TransactionStatus.PENDING,
        assetSymbol: asset,
        amount: new Decimal(amount),
        network,
        memo: `Referral reward tranche #${tranche.seq} (${tranche.leg})`,
      },
    })

    const op = await enqueueOutboxOp(tx, {
      idempotencyKey,
      userId: recipientUserId,
      kind: 'REFERRAL_REWARD',
      actor: 'SYSTEM',
      payload: {
        method: 'referral_reward',
        transactionId: transaction.id,
        recipientAddress: address,
        amount,
        assetSymbol: asset,
        conversionId: tranche.conversionId,
        leg: tranche.leg === 'referrer' ? 'owner' : 'referred',
      },
    })

    return { transaction, opId: op.id }
  })

  try {
    const result = await dispatchOne(pending.opId)
    const succeeded = !result.status || result.status === 'success'
    const stillPending = result.status === 'pending'

    await database.transaction.update({
      where: { id: pending.transaction.id },
      data: {
        txHash: result.hash,
        status: stillPending
          ? TransactionStatus.PENDING
          : succeeded
            ? TransactionStatus.CONFIRMED
            : TransactionStatus.FAILED,
        confirmedAt: succeeded ? new Date() : null,
      },
    })

    if (!succeeded && !stillPending) {
      throw new Error('On-chain tranche reward submission returned status=failed')
    }

    return {
      confirmed: Boolean(succeeded && result.hash),
      txHash: result.hash ?? null,
      rewardTxId: pending.transaction.id,
      outboxOpId: pending.opId,
    }
  } catch (err) {
    await database.transaction
      .update({
        where: { id: pending.transaction.id },
        data: { status: TransactionStatus.FAILED },
      })
      .catch(() => {})
    throw err
  }
}

/**
 * Sweep vesting tranches and clawbacks (#364):
 *   1. Expire stale OPEN clawbacks past `CLAWBACK_WRITEOFF_DAYS`.
 *   2. Check conversions with at least one `VESTED_PAID` tranche and remaining
 *      `PENDING` tranches for mid-vesting balance drops or Sybil/manual denial,
 *      recording clawbacks when triggered.
 *   3. Evaluate due `PENDING` tranches (`vestsAt <= now`) against the M-snapshot
 *      balance checkpoint, paying vested tranches (net of any clawback offset)
 *      or forfeiting them.
 *   4. Advance `ReferralConversion.status` to `REWARDED` only when all tranches
 *      for that conversion are terminal.
 */
export async function sweepVestingTranchesAndClawbacks(
  now: Date = new Date(),
  database: any = db
): Promise<{
  conversionsScanned: number
  conversionsRewarded: number
  tranchesPaid: number
  tranchesForfeited: number
  clawbacksRecorded: number
}> {
  await expireStaleClawbacks(now, database)

  const conversions = await database.referralConversion.findMany({
    where: {
      status: ReferralStatus.ACTIVATED,
    },
    orderBy: { activatedAt: 'asc' },
    take: 200,
    include: {
      referralCode: true,
      tranches: {
        orderBy: { seq: 'asc' },
      },
    },
  })

  let conversionsRewarded = 0
  let tranchesPaid = 0
  let tranchesForfeited = 0
  let clawbacksRecorded = 0

  for (const conversion of conversions) {
    const tranches: any[] = Array.isArray(conversion.tranches)
      ? conversion.tranches
      : []
    if (tranches.length === 0) continue

    const ownerUserId = conversion.referralCode.ownerUserId
    const referredUserId = conversion.referredUserId

    // Check if conversion was rejected/denied after an earlier tranche was paid
    const isRejectedOrDenied =
      conversion.manualReviewRejected === true ||
      (conversion as any).payoutHold === 'DENIED'

    if (isRejectedOrDenied) {
      const hasPaid = tranches.some((t) => t.status === 'VESTED_PAID')
      const hasPending = tranches.some((t) => t.status === 'PENDING')
      if (hasPaid || hasPending) {
        const cbRes = await recordEarlyWithdrawalClawback({
          conversionId: conversion.id,
          referrerUserId: ownerUserId,
          reason: 'CONVERSION_DENIED_AFTER_PARTIAL_VEST',
          now,
          database,
        })
        if (cbRes.clawbackCreated) clawbacksRecorded++
        tranchesForfeited += cbRes.forfeitedTrancheCount
      }
      continue
    }

    if (conversion.manualReviewRequired) {
      continue
    }

    // If conversion already has a VESTED_PAID tranche and still has PENDING
    // tranches (vesting period not yet over), check if referred user pulled out
    // early even before the next vestsAt date.
    const hasPaidReferrerTranche = tranches.some(
      (t) => t.leg === 'referrer' && t.status === 'VESTED_PAID'
    )
    const pendingTranches = tranches.filter((t) => t.status === 'PENDING')

    if (hasPaidReferrerTranche && pendingTranches.length > 0) {
      const minRequired = pendingTranches[0].requiresBalanceAtLeast
      const earlyCheck = await evaluateReferredBalanceCheckpoint({
        referredUserId,
        requiresBalanceAtLeast: minRequired,
        vestsAt: now,
        now,
        database,
      })

      if (!earlyCheck.meetsThreshold && earlyCheck.sustainedDrop) {
        const cbRes = await recordEarlyWithdrawalClawback({
          conversionId: conversion.id,
          referrerUserId: ownerUserId,
          reason: 'EARLY_WITHDRAWAL_BEFORE_VESTING_END',
          now,
          database,
        })
        if (cbRes.clawbackCreated) clawbacksRecorded++
        tranchesForfeited += cbRes.forfeitedTrancheCount

        // Reload tranches to check if all are now terminal
        const updatedTranches = await database.referralRewardTranche.findMany({
          where: { conversionId: conversion.id },
        })
        if (
          updatedTranches.length > 0 &&
          updatedTranches.every((t: any) => isTerminalTrancheStatus(t.status))
        ) {
          await database.referralConversion.update({
            where: { id: conversion.id },
            data: { status: ReferralStatus.REWARDED, payoutError: null },
          })
          conversionsRewarded++
        }
        continue
      }
    }

    // Process due PENDING tranches (vestsAt <= now)
    const referredUser = await database.user?.findUnique?.({
      where: { id: referredUserId },
      select: { network: true },
    })
    const network = referredUser?.network ?? Network.MAINNET

    let EarlyClawbackTriggeredInLoop = false
    for (const tranche of pendingTranches) {
      if (EarlyClawbackTriggeredInLoop) break
      if (new Date(tranche.vestsAt).getTime() > now.getTime()) {
        continue
      }

      const checkpoint = await evaluateReferredBalanceCheckpoint({
        referredUserId,
        requiresBalanceAtLeast: tranche.requiresBalanceAtLeast,
        vestsAt: new Date(tranche.vestsAt),
        now,
        database,
      })

      if (!checkpoint.meetsThreshold) {
        // If an earlier tranche was already VESTED_PAID, this drop before the
        // vesting period ends triggers clawback + forfeits all remaining PENDING tranches.
        const anyPaidSoFar = tranches.some(
          (t) => t.leg === 'referrer' && t.status === 'VESTED_PAID'
        )
        if (anyPaidSoFar) {
          const cbRes = await recordEarlyWithdrawalClawback({
            conversionId: conversion.id,
            referrerUserId: ownerUserId,
            reason:
              checkpoint.reason ??
              'EARLY_WITHDRAWAL_BEFORE_VESTING_END',
            now,
            database,
          })
          if (cbRes.clawbackCreated) clawbacksRecorded++
          tranchesForfeited += cbRes.forfeitedTrancheCount
          EarlyClawbackTriggeredInLoop = true
          break
        }

        // Otherwise (e.g. tranche 1 failed checkpoint), forfeit this tranche
        await database.referralRewardTranche.update({
          where: { id: tranche.id },
          data: {
            status: 'FORFEITED',
            forfeitReason:
              checkpoint.reason ?? 'INSUFFICIENT_DEPOSITED_BALANCE_AT_CHECKPOINT',
            evaluatedAt: now,
          },
        })
        tranche.status = 'FORFEITED'
        tranchesForfeited++

        await writeAuditHash(
          database,
          'referral_reward_tranches',
          'REFERRAL_TRANCHE_FORFEITED',
          {
            trancheId: tranche.id,
            conversionId: conversion.id,
            leg: tranche.leg,
            seq: tranche.seq,
            amount: String(tranche.amount),
            reason:
              checkpoint.reason ?? 'INSUFFICIENT_DEPOSITED_BALANCE_AT_CHECKPOINT',
            evaluatedAt: now.toISOString(),
          }
        )

        if (tranche.leg === 'referrer') {
          await publishUserEvent(
            ownerUserId,
            EVENT_TYPE_TOPIC['referral.tranche_forfeited'],
            'referral.tranche_forfeited',
            {
              conversionId: conversion.id,
              trancheId: tranche.id,
              leg: tranche.leg,
              seq: tranche.seq,
              amount: Number(tranche.amount),
              reason:
                checkpoint.reason ??
                'INSUFFICIENT_DEPOSITED_BALANCE_AT_CHECKPOINT',
              forfeitedAt: now.toISOString(),
            }
          ).catch(() => {})
        }
        continue
      }

      // Balance meets threshold -> pay tranche (applying clawback offset for referrer leg)
      const recipientUserId =
        tranche.leg === 'referrer' ? ownerUserId : referredUserId
      let payableAmount = Number(tranche.amount)

      if (tranche.leg === 'referrer' && payableAmount > 0) {
        const offsetRes = await applyClawbackOffsetToReward({
          referrerUserId: ownerUserId,
          grossRewardAmount: payableAmount,
          conversionId: conversion.id,
          trancheId: tranche.id,
          now,
          database,
        })
        payableAmount = offsetRes.netPayableAmount
      }

      if (payableAmount <= 0) {
        // Fully offset against an open clawback — no on-chain transfer needed
        await database.referralRewardTranche.update({
          where: { id: tranche.id },
          data: {
            status: 'VESTED_PAID',
            paidTxHash: 'CLAWBACK_OFFSET',
            payoutError: null,
            evaluatedAt: now,
          },
        })
        tranche.status = 'VESTED_PAID'
        tranchesPaid++

        await writeAuditHash(
          database,
          'referral_reward_tranches',
          'REFERRAL_TRANCHE_PAID',
          {
            trancheId: tranche.id,
            conversionId: conversion.id,
            leg: tranche.leg,
            seq: tranche.seq,
            grossAmount: String(tranche.amount),
            netPaidOnChain: '0',
            paidTxHash: 'CLAWBACK_OFFSET',
            evaluatedAt: now.toISOString(),
          }
        )
        continue
      }

      try {
        const payRes = await payVestingTrancheOnChain({
          tranche,
          recipientUserId,
          amount: payableAmount,
          network,
          database,
        })

        if (payRes.confirmed && payRes.txHash) {
          await database.referralRewardTranche.update({
            where: { id: tranche.id },
            data: {
              status: 'VESTED_PAID',
              paidTxHash: payRes.txHash,
              rewardTxId: payRes.rewardTxId,
              outboxOpId: payRes.outboxOpId,
              payoutError: null,
              evaluatedAt: now,
            },
          })
          tranche.status = 'VESTED_PAID'
          tranchesPaid++

          await writeAuditHash(
            database,
            'referral_reward_tranches',
            'REFERRAL_TRANCHE_PAID',
            {
              trancheId: tranche.id,
              conversionId: conversion.id,
              leg: tranche.leg,
              seq: tranche.seq,
              grossAmount: String(tranche.amount),
              netPaidOnChain: String(payableAmount),
              paidTxHash: payRes.txHash,
              rewardTxId: payRes.rewardTxId,
              evaluatedAt: now.toISOString(),
            }
          )
        } else {
          // Still pending confirmation — keep tranche PENDING with outboxOpId/rewardTxId
          await database.referralRewardTranche.update({
            where: { id: tranche.id },
            data: {
              rewardTxId: payRes.rewardTxId,
              outboxOpId: payRes.outboxOpId,
              evaluatedAt: now,
            },
          })
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        await database.referralRewardTranche
          .update({
            where: { id: tranche.id },
            data: {
              payoutError: msg.slice(0, 500),
              evaluatedAt: now,
            },
          })
          .catch(() => {})
        await database.referralConversion
          .update({
            where: { id: conversion.id },
            data: {
              payoutError: `${tranche.leg}#${tranche.seq}: ${msg}`.slice(
                0,
                500
              ),
            },
          })
          .catch(() => {})
      }
    }

    // Check if all tranches for this conversion are now terminal
    const latestTranches = await database.referralRewardTranche.findMany({
      where: { conversionId: conversion.id },
    })
    if (
      Array.isArray(latestTranches) &&
      latestTranches.length > 0 &&
      latestTranches.every((t: any) => isTerminalTrancheStatus(t.status))
    ) {
      await database.referralConversion.update({
        where: { id: conversion.id },
        data: { status: ReferralStatus.REWARDED, payoutError: null },
      })
      conversionsRewarded++
    }
  }

  return {
    conversionsScanned: conversions.length,
    conversionsRewarded,
    tranchesPaid,
    tranchesForfeited,
    clawbacksRecorded,
  }
}
