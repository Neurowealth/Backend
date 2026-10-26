/**
 * Referral Sybil & Abuse Detection Signals (#363).
 *
 * Evaluates 6 weighted, configurable abuse signals at activation time and at
 * payout-release time:
 *   1. `self_funding_chain`
 *   2. `deposit_then_withdraw`
 *   3. `burst_activations`
 *   4. `shared_fingerprint`
 *   5. `circular_referral`
 *   6. `fresh_wallet_cohort`
 *
 * Produces a normalized `abuseRiskScore` (0..100), machine-readable
 * `abuseReasons`, `modelVersion`, and a deterministic `payoutHold` state
 * (`NONE` | `AUTO_REVIEW` | `DENIED`).
 */
import db from '../db'
import { config } from '../config'

export type AbuseSignalCode =
  | 'self_funding_chain'
  | 'deposit_then_withdraw'
  | 'burst_activations'
  | 'shared_fingerprint'
  | 'circular_referral'
  | 'fresh_wallet_cohort'

export type PayoutHoldState = 'NONE' | 'AUTO_REVIEW' | 'DENIED'

export interface AbuseSignalFinding {
  code: AbuseSignalCode
  weight: number
  evidence: Record<string, unknown>
}

export interface AbuseEvaluationResult {
  abuseRiskScore: number
  abuseReasons: AbuseSignalCode[]
  findings: AbuseSignalFinding[]
  modelVersion: string
  payoutHold: PayoutHoldState
}

function extractIpv4Subnet24(ip: string | null | undefined): string | null {
  if (!ip) return null
  const trimmed = ip.trim().toLowerCase()
  const parts = trimmed.split('.')
  if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p))) {
    return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`
  }
  return trimmed || null
}

/**
 * Check whether attributing `referredUserId` to `ownerUserId` creates a cycle
 * of length <= 3 in the referral graph (e.g. A -> B -> A or A -> B -> C -> A).
 */
export async function detectCircularReferral(
  ownerUserId: string,
  referredUserId: string,
  database: any = db
): Promise<{ isCircular: boolean; chain: string[] }> {
  if (ownerUserId === referredUserId) {
    return { isCircular: true, chain: [ownerUserId, referredUserId] }
  }

  // Walk backwards from ownerUserId up to 2 ancestor hops (total cycle length <= 3)
  let currentUserId = ownerUserId
  const chain: string[] = [referredUserId, ownerUserId]

  for (let depth = 0; depth < 2; depth++) {
    const parentConversion = await database.referralConversion?.findUnique?.({
      where: { referredUserId: currentUserId },
      include: { referralCode: true },
    })
    const parentOwnerId = parentConversion?.referralCode?.ownerUserId
    if (
      !parentOwnerId ||
      parentOwnerId === currentUserId ||
      (parentConversion?.referredUserId &&
        parentConversion.referredUserId !== currentUserId)
    ) {
      break
    }

    chain.push(parentOwnerId)
    if (parentOwnerId === referredUserId) {
      return { isCircular: true, chain }
    }
    currentUserId = parentOwnerId
  }

  return { isCircular: false, chain: [] }
}

/**
 * Evaluate whether the referred user has withdrawn >= `withdrawalHoldRatio` (80%)
 * of `qualifyingDepositAmount` since `activatedAt`.
 */
export async function checkDepositThenWithdraw(params: {
  referredUserId: string
  qualifyingDepositAmount: number
  since: Date
  withdrawalHoldRatio?: number
  database?: any
}): Promise<{
  triggered: boolean
  withdrawnAmount: number
  withdrawnRatio: number
}> {
  const database = params.database ?? db
  const ratioThreshold =
    params.withdrawalHoldRatio ??
    config.referral.sybil?.withdrawalHoldRatio ??
    0.8

  if (params.qualifyingDepositAmount <= 0) {
    return { triggered: false, withdrawnAmount: 0, withdrawnRatio: 0 }
  }

  let withdrawals: any[] = []
  try {
    const rows = await database.transaction?.findMany?.({
      where: {
        userId: params.referredUserId,
        type: 'WITHDRAWAL',
        status: { in: ['CONFIRMED', 'PENDING'] },
        createdAt: { gte: params.since },
      },
      select: { amount: true },
    })
    if (Array.isArray(rows)) {
      withdrawals = rows
    }
  } catch {
    return { triggered: false, withdrawnAmount: 0, withdrawnRatio: 0 }
  }

  const withdrawnAmount = withdrawals.reduce(
    (sum: number, tx: any) => sum + Number(tx.amount ?? 0),
    0
  )
  const withdrawnRatio = withdrawnAmount / params.qualifyingDepositAmount

  return {
    triggered: withdrawnRatio >= ratioThreshold,
    withdrawnAmount,
    withdrawnRatio,
  }
}

/**
 * Run all 6 Sybil & abuse signals for a conversion.
 */
export async function evaluateAbuseSignals(params: {
  conversionId?: string
  referralCodeId: string
  ownerUserId: string
  referredUserId: string
  qualifyingDepositAmount: number
  activationTxId?: string | null
  activatedAt?: Date
  now?: Date
  preloadedSessions?: {
    ownerSessions: Array<{
      ipAddress?: string | null
      lastSeenIp?: string | null
      userAgent?: string | null
    }>
    referredSessions: Array<{
      ipAddress?: string | null
      lastSeenIp?: string | null
      userAgent?: string | null
    }>
  }
  database?: any
}): Promise<AbuseEvaluationResult> {
  const database = params.database ?? db
  const now = params.now ?? new Date()
  const sybilCfg = config.referral.sybil ?? {
    modelVersion: 'sybil-v1',
    holdThreshold: 40,
    denyThreshold: 80,
    selfFundingWindowHours: 72,
    withdrawalHoldRatio: 0.8,
    burstActivationCount: 5,
    burstWindowMinutes: 60,
    freshWalletClusterCount: 3,
    freshWalletWindowMinutes: 10,
    weights: {
      self_funding_chain: 50,
      deposit_then_withdraw: 60,
      burst_activations: 45,
      shared_fingerprint: 40,
      circular_referral: 85,
      fresh_wallet_cohort: 45,
    },
  }

  const findings: AbuseSignalFinding[] = []

  // ── Signal 1: self_funding_chain ───────────────────────────────────────────
  try {
    const windowCutoff = new Date(
      now.getTime() - sybilCfg.selfFundingWindowHours * 3600_000
    )
    const [ownerUser, referredUser, ownerWithdrawals, referredDeposits] =
      await Promise.all([
        database.user?.findUnique?.({
          where: { id: params.ownerUserId },
          select: { walletAddress: true },
        }),
        database.user?.findUnique?.({
          where: { id: params.referredUserId },
          select: { walletAddress: true },
        }),
        database.transaction?.findMany?.({
          where: {
            userId: params.ownerUserId,
            type: 'WITHDRAWAL',
            status: 'CONFIRMED',
            createdAt: { gte: windowCutoff },
          },
          select: { id: true, amount: true, memo: true, txHash: true },
        }),
        database.transaction?.findMany?.({
          where: {
            userId: params.referredUserId,
            type: 'DEPOSIT',
            status: 'CONFIRMED',
            createdAt: { gte: windowCutoff },
          },
          select: { id: true, amount: true, memo: true, txHash: true },
        }),
      ])

    const ownerAddr = ownerUser?.walletAddress?.toLowerCase() ?? ''
    const referredAddr = referredUser?.walletAddress?.toLowerCase() ?? ''
    let matchedChain = false
    let matchEvidence: Record<string, unknown> = {}

    if (
      Array.isArray(ownerWithdrawals) &&
      Array.isArray(referredDeposits) &&
      ownerWithdrawals.length > 0 &&
      referredDeposits.length > 0
    ) {
      for (const w of ownerWithdrawals) {
        const wAmt = Number(w.amount ?? 0)
        const wMemo = String(w.memo ?? '').toLowerCase()
        for (const d of referredDeposits) {
          const dAmt = Number(d.amount ?? 0)
          const dMemo = String(d.memo ?? '').toLowerCase()
          const closeAmount =
            wAmt > 0 && dAmt > 0 && Math.abs(wAmt - dAmt) / wAmt <= 0.05
          const directLink =
            (referredAddr && wMemo.includes(referredAddr)) ||
            (ownerAddr && dMemo.includes(ownerAddr)) ||
            (wMemo.startsWith('funder:') && wMemo === dMemo) ||
            closeAmount

          if (directLink) {
            matchedChain = true
            matchEvidence = {
              ownerWithdrawalTxId: w.id,
              referredDepositTxId: d.id,
              amountRatio: wAmt > 0 ? Number((dAmt / wAmt).toFixed(4)) : 1,
            }
            break
          }
        }
        if (matchedChain) break
      }
    }

    if (matchedChain) {
      findings.push({
        code: 'self_funding_chain',
        weight: sybilCfg.weights.self_funding_chain,
        evidence: matchEvidence,
      })
    }
  } catch {
    // Non-fatal per-signal guard; overall scorer remains fail-closed if outer throws
  }

  // ── Signal 2: deposit_then_withdraw ────────────────────────────────────────
  try {
    const since =
      params.activatedAt ?? new Date(now.getTime() - 24 * 3600_000)
    const dtw = await checkDepositThenWithdraw({
      referredUserId: params.referredUserId,
      qualifyingDepositAmount: params.qualifyingDepositAmount,
      since,
      withdrawalHoldRatio: sybilCfg.withdrawalHoldRatio,
      database,
    })
    if (dtw.triggered) {
      findings.push({
        code: 'deposit_then_withdraw',
        weight: sybilCfg.weights.deposit_then_withdraw,
        evidence: {
          withdrawnRatio: Number(dtw.withdrawnRatio.toFixed(4)),
        },
      })
    }
  } catch {}

  // ── Signal 3: burst_activations ────────────────────────────────────────────
  try {
    const burstCutoff = new Date(
      now.getTime() - sybilCfg.burstWindowMinutes * 60_000
    )
    const recentActivations = await database.referralConversion?.findMany?.({
      where: {
        referralCodeId: params.referralCodeId,
        status: { in: ['ACTIVATED', 'REWARDED', 'FLAGGED'] },
        activatedAt: { gte: burstCutoff },
      },
      select: {
        id: true,
        qualifyingDepositAmount: true,
      },
    })

    const count = (Array.isArray(recentActivations) ? recentActivations.length : 0) + 1
    if (count >= sybilCfg.burstActivationCount) {
      const minThreshold = config.referral.minActivationDeposit || 10
      const deposits = [
        params.qualifyingDepositAmount,
        ...(Array.isArray(recentActivations)
          ? recentActivations
              .map((r: any) =>
                r.qualifyingDepositAmount != null
                  ? Number(r.qualifyingDepositAmount)
                  : params.qualifyingDepositAmount
              )
          : []),
      ]
      const mean =
        deposits.reduce((a, b) => a + b, 0) / Math.max(1, deposits.length)
      const allNearIdenticalOrThreshold = deposits.every(
        (amt) =>
          Math.abs(amt - mean) / Math.max(1, mean) <= 0.05 ||
          Math.abs(amt - minThreshold) / Math.max(1, minThreshold) <= 0.05
      )

      if (allNearIdenticalOrThreshold) {
        findings.push({
          code: 'burst_activations',
          weight: sybilCfg.weights.burst_activations,
          evidence: {
            activationsInWindow: count,
            windowMinutes: sybilCfg.burstWindowMinutes,
          },
        })
      }
    }
  } catch {}

  // ── Signal 4: shared_fingerprint (IP /24 subnet, device UA, or card ref) ───
  try {
    const [ownerSessions, referredSessions, ownerPlans, referredPlans] =
      await Promise.all([
        params.preloadedSessions
          ? Promise.resolve(params.preloadedSessions.ownerSessions)
          : database.session?.findMany?.({
              where: { userId: params.ownerUserId },
              select: { ipAddress: true, lastSeenIp: true, userAgent: true },
            }),
        params.preloadedSessions
          ? Promise.resolve(params.preloadedSessions.referredSessions)
          : database.session?.findMany?.({
              where: { userId: params.referredUserId },
              select: { ipAddress: true, lastSeenIp: true, userAgent: true },
            }),
        database.fiatPurchasePlan?.findMany?.({
          where: { userId: params.ownerUserId },
          select: { paymentMethodRef: true },
        }),
        database.fiatPurchasePlan?.findMany?.({
          where: { userId: params.referredUserId },
          select: { paymentMethodRef: true },
        }),
      ])

    const ownerSubnets = new Set<string>()
    const ownerAgents = new Set<string>()
    for (const s of Array.isArray(ownerSessions) ? ownerSessions : []) {
      const sub1 = extractIpv4Subnet24(s.ipAddress)
      const sub2 = extractIpv4Subnet24(s.lastSeenIp)
      if (sub1) ownerSubnets.add(sub1)
      if (sub2) ownerSubnets.add(sub2)
      if (s.userAgent?.trim()) ownerAgents.add(s.userAgent.trim().toLowerCase())
    }

    let sharedSubnetCount = 0
    let sharedAgentCount = 0
    for (const s of Array.isArray(referredSessions) ? referredSessions : []) {
      const sub1 = extractIpv4Subnet24(s.ipAddress)
      const sub2 = extractIpv4Subnet24(s.lastSeenIp)
      if ((sub1 && ownerSubnets.has(sub1)) || (sub2 && ownerSubnets.has(sub2))) {
        sharedSubnetCount++
      }
      if (
        s.userAgent?.trim() &&
        ownerAgents.has(s.userAgent.trim().toLowerCase())
      ) {
        sharedAgentCount++
      }
    }

    const ownerCardRefs = new Set(
      (Array.isArray(ownerPlans) ? ownerPlans : [])
        .map((p: any) => p.paymentMethodRef)
        .filter(Boolean)
    )
    const sharedCardCount = (Array.isArray(referredPlans) ? referredPlans : []).filter(
      (p: any) => p.paymentMethodRef && ownerCardRefs.has(p.paymentMethodRef)
    ).length

    if (
      sharedSubnetCount > 0 ||
      sharedAgentCount > 0 ||
      sharedCardCount > 0
    ) {
      findings.push({
        code: 'shared_fingerprint',
        weight: sybilCfg.weights.shared_fingerprint,
        evidence: {
          sharedSubnetCount,
          sharedAgentCount,
          sharedCardCount,
        },
      })
    }
  } catch {}

  // ── Signal 5: circular_referral ────────────────────────────────────────────
  try {
    const circular = await detectCircularReferral(
      params.ownerUserId,
      params.referredUserId,
      database
    )
    if (circular.isCircular) {
      findings.push({
        code: 'circular_referral',
        weight: sybilCfg.weights.circular_referral,
        evidence: {
          cycleLength: Math.max(1, circular.chain.length - 1),
        },
      })
    }
  } catch {}

  // ── Signal 6: fresh_wallet_cohort ──────────────────────────────────────────
  try {
    const referredUser = await database.user?.findUnique?.({
      where: { id: params.referredUserId },
      select: { createdAt: true },
    })
    if (referredUser?.createdAt) {
      const createdTime = new Date(referredUser.createdAt).getTime()
      const windowMs = sybilCfg.freshWalletWindowMinutes * 60_000
      const siblingConversions = await database.referralConversion?.findMany?.({
        where: {
          referralCodeId: params.referralCodeId,
          referredUser: {
            createdAt: {
              gte: new Date(createdTime - windowMs),
              lte: new Date(createdTime + windowMs),
            },
          },
        },
        select: { referredUserId: true },
      })

      const clusterSize = Array.isArray(siblingConversions)
        ? new Set([
            params.referredUserId,
            ...siblingConversions.map((c: any) => c.referredUserId),
          ]).size
        : 1

      if (clusterSize >= sybilCfg.freshWalletClusterCount) {
        findings.push({
          code: 'fresh_wallet_cohort',
          weight: sybilCfg.weights.fresh_wallet_cohort,
          evidence: {
            clusterSize,
            windowMinutes: sybilCfg.freshWalletWindowMinutes,
          },
        })
      }
    }
  } catch {}

  const rawScore = findings.reduce((sum, f) => sum + f.weight, 0)
  const abuseRiskScore = Math.min(100, Math.max(0, rawScore))
  const abuseReasons = findings.map((f) => f.code)

  let payoutHold: PayoutHoldState = 'NONE'
  if (abuseRiskScore >= sybilCfg.denyThreshold) {
    payoutHold = 'DENIED'
  } else if (abuseRiskScore >= sybilCfg.holdThreshold) {
    payoutHold = 'AUTO_REVIEW'
  }

  return {
    abuseRiskScore,
    abuseReasons,
    findings,
    modelVersion: sybilCfg.modelVersion,
    payoutHold,
  }
}
