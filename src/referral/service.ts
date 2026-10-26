/**
 * Referral rewards program (single-level).
 *
 * Lifecycle: a ReferralConversion is created in PENDING at signup time
 * (attribution at the source). It advances to ACTIVATED only when a real,
 * on-chain-confirmed deposit Transaction crosses the activation threshold —
 * checked inside the same DB transaction that persists the deposit, never on a
 * client-reported claim. A separate payout job then pays both parties and moves
 * the row to REWARDED.
 *
 * Money movement is intentionally split from activation: activation is a pure
 * DB state change and runs transactionally with the deposit; the payout is an
 * irreversible on-chain call and runs in a separate sweep (see
 * jobs/referralPayout.ts). This mirrors the fiat on-ramp settlement/reconcile
 * split and keeps Stellar RPC calls out of the event-listener DB transaction.
 */
import { randomBytes } from 'crypto'
import {
  Prisma,
  ReferralStatus,
  TransactionType,
  TransactionStatus,
  Network,
} from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import db from '../db'
import { config } from '../config'
import { logger } from '../utils/logger'
import { alertingService } from '../services/alerting'
import { getWalletByUserId } from '../stellar/wallet'
import { enqueueOutboxOp } from '../outbox/service'
import { dispatchOne } from '../outbox/dispatcher'
import { deriveIdempotencyKey } from '../outbox/idempotency'
import { auditPayloadHashFor } from '../audit/chain'
import {
  getActiveRewardSchedule,
  calculateTieredReferralReward,
  resolveMilestoneTier,
} from './schedule'
import {
  evaluateAbuseSignals,
  detectCircularReferral,
  checkDepositThenWithdraw,
  type PayoutHoldState,
} from './abuseSignals'

type Db = typeof db | Prisma.TransactionClient

/**
 * Fraud detection flags for referral conversions (#490).
 */
export enum ReferralFraudFlag {
  SELF_REFERRAL_BLOCKED = 'SELF_REFERRAL_BLOCKED',
  DUPLICATE_WALLET = 'DUPLICATE_WALLET',
  DUPLICATE_EMAIL = 'DUPLICATE_EMAIL',
  DUPLICATE_PHONE = 'DUPLICATE_PHONE',
  SUSPICIOUS_VELOCITY = 'SUSPICIOUS_VELOCITY',
  SAME_IP_ADDRESS = 'SAME_IP_ADDRESS',
  RAPID_ACTIVATION = 'RAPID_ACTIVATION',
  SUSPICIOUS_WITHDRAWAL_PATTERN = 'SUSPICIOUS_WITHDRAWAL_PATTERN',
}

export interface ReferralFraudCheckResult {
  passed: boolean
  flags: ReferralFraudFlag[]
  riskScore: number
  requiresManualReview: boolean
  details: Record<string, any>
}

/**
 * Check for referral fraud patterns before attribution.
 * Returns fraud check result with flags and risk score.
 */
export async function checkReferralFraud(
  referredUserId: string,
  referralCodeId: string,
  database: Db = db
): Promise<ReferralFraudCheckResult> {
  const fraudCfg = config.referral?.fraud ?? {
    blockScore: 100,
    reviewScore: 80,
    weights: {
      duplicateWallet: 100,
      duplicateEmail: 50,
      duplicatePhone: 50,
      sameIp: 40,
      velocity: 30,
      rapidActivation: 40,
    },
    velocityCount: 5,
    rapidActivationCount: 3,
    targetPrecision: 0.7,
  }
  const flags: ReferralFraudFlag[] = []
  let riskScore = 0
  const details: Record<string, any> = {}

  if (typeof (database as any).user?.count !== 'function') {
    return {
      passed: true,
      flags: [],
      riskScore: 0,
      requiresManualReview: false,
      details: {},
    }
  }

  const [referredUser, referralCode] = await Promise.all([
    (database as any).user.findUnique({
      where: { id: referredUserId },
      select: {
        walletAddress: true,
        email: true,
        phone: true,
        createdAt: true,
        sessions: {
          select: { ipAddress: true },
          orderBy: { createdAt: 'desc' },
          take: 5,
        },
      },
    }),
    (database as any).referralCode.findUnique({
      where: { id: referralCodeId },
      include: {
        owner: {
          select: {
            walletAddress: true,
            email: true,
            phone: true,
            sessions: {
              select: { ipAddress: true },
              orderBy: { createdAt: 'desc' },
              take: 5,
            },
          },
        },
      },
    }),
  ])

  if (!referredUser || !referralCode) {
    throw new Error('User or referral code not found')
  }

  // Check 1: Duplicate wallet (already caught by unique constraint, but check anyway)
  const duplicateWallet = await (database as any).user.count({
    where: {
      walletAddress: referredUser.walletAddress,
      id: { not: referredUserId },
    },
  })
  if (duplicateWallet > 0) {
    flags.push(ReferralFraudFlag.DUPLICATE_WALLET)
    riskScore += fraudCfg.weights.duplicateWallet
    details.duplicateWallet = true
  }

  // Check 2: Duplicate email
  if (referredUser.email) {
    const duplicateEmail = await (database as any).user.count({
      where: {
        email: referredUser.email,
        id: { not: referredUserId },
      },
    })
    if (duplicateEmail > 0) {
      flags.push(ReferralFraudFlag.DUPLICATE_EMAIL)
      riskScore += fraudCfg.weights.duplicateEmail
      details.duplicateEmail = true
    }
  }

  // Check 3: Duplicate phone
  if (referredUser.phone) {
    const duplicatePhone = await (database as any).user.count({
      where: {
        phone: referredUser.phone,
        id: { not: referredUserId },
      },
    })
    if (duplicatePhone > 0) {
      flags.push(ReferralFraudFlag.DUPLICATE_PHONE)
      riskScore += fraudCfg.weights.duplicatePhone
      details.duplicatePhone = true
    }
  }

  // Check 4: Shared IP address with referrer
  const referredIps = new Set(
    referredUser.sessions.map((s: any) => s.ipAddress).filter(Boolean)
  )
  const referrerIps = new Set(
    referralCode.owner.sessions.map((s: any) => s.ipAddress).filter(Boolean)
  )
  const sharedIps = [...referredIps].filter((ip) => referrerIps.has(ip))
  if (sharedIps.length > 0) {
    flags.push(ReferralFraudFlag.SAME_IP_ADDRESS)
    riskScore += fraudCfg.weights.sameIp
    details.sharedIps = sharedIps
  }

  // Check 5: Suspicious velocity - recent conversions from same referrer
  const recentConversions = await (database as any).referralConversion.count({
    where: {
      referralCodeId,
      createdAt: { gt: new Date(Date.now() - 24 * 60 * 60 * 1000) }, // 24h
    },
  })
  if (recentConversions >= fraudCfg.velocityCount) {
    flags.push(ReferralFraudFlag.SUSPICIOUS_VELOCITY)
    riskScore += fraudCfg.weights.velocity
    details.recentConversions = recentConversions
  }

  // Check 6: Rapid activation pattern - many conversions activated quickly
  const rapidActivations = await (database as any).referralConversion.count({
    where: {
      referralCodeId,
      status: ReferralStatus.ACTIVATED,
      activatedAt: { gt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }, // 7d
    },
  })
  if (rapidActivations >= fraudCfg.rapidActivationCount) {
    flags.push(ReferralFraudFlag.RAPID_ACTIVATION)
    riskScore += fraudCfg.weights.rapidActivation
    details.rapidActivations = rapidActivations
  }

  const requiresManualReview = riskScore >= fraudCfg.reviewScore
  const passed = riskScore < fraudCfg.blockScore

  return {
    passed,
    flags,
    riskScore,
    requiresManualReview,
    details,
  }
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no ambiguous 0/O/1/I
const CODE_LENGTH = 8
const CODE_MAX_ATTEMPTS = 5

// ---------------------------------------------------------------------------
// Fraud/abuse heuristics (#397)
// ---------------------------------------------------------------------------

export interface ReferralFraudSignal {
  reason: string
  detail: string
}

export interface ReferralFraudAssessment {
  suspicious: boolean
  signals: ReferralFraudSignal[]
}

/** Lowercased, trimmed; empty/placeholder values never count as a match. */
function normalizeSignalValue(value: string | null | undefined): string | null {
  if (!value) return null
  const normalized = value.trim().toLowerCase()
  return normalized.length > 0 ? normalized : null
}

interface SignalSession {
  ipAddress: string | null
  lastSeenIp: string | null
  userAgent: string | null
}

function collectSessionValues(
  sessions: SignalSession[],
  pick: (s: SignalSession) => (string | null)[]
): Set<string> {
  const values = new Set<string>()
  for (const session of sessions) {
    for (const raw of pick(session)) {
      const normalized = normalizeSignalValue(raw)
      if (normalized) values.add(normalized)
    }
  }
  return values
}

/**
 * Evaluates a referrer/referred pair for signs of referral-ring abuse (one
 * operator farming the reward across multiple accounts) using IP and
 * device-fingerprint overlap between their sessions.
 *
 * Deliberately heuristic, not a hard block: shared IPs/devices happen
 * legitimately (family, office, shared campus wifi), so this only produces
 * signals for the caller to route to manual review — see
 * checkAndActivateOnDeposit, which flags rather than silently blocks.
 */
export async function evaluateReferralFraudRisk(
  ownerUserId: string,
  referredUserId: string,
  database: Db = db
): Promise<ReferralFraudAssessment> {
  const [ownerSessions, referredSessions] = await Promise.all([
    (database as any).session.findMany({
      where: { userId: ownerUserId },
      select: { ipAddress: true, lastSeenIp: true, userAgent: true },
    }),
    (database as any).session.findMany({
      where: { userId: referredUserId },
      select: { ipAddress: true, lastSeenIp: true, userAgent: true },
    }),
  ])

  const signals: ReferralFraudSignal[] = []

  const ownerIps = collectSessionValues(ownerSessions, (s) => [
    s.ipAddress,
    s.lastSeenIp,
  ])
  const referredIps = collectSessionValues(referredSessions, (s) => [
    s.ipAddress,
    s.lastSeenIp,
  ])
  const sharedIps = [...ownerIps].filter((ip) => referredIps.has(ip))

  if (sharedIps.length > 0) {
    signals.push({
      reason: 'shared_ip',
      detail: `${sharedIps.length} shared IP address(es) between referrer and referred account`,
    })
  }

  // User-agent string is a coarse device-fingerprint proxy — the platform
  // does not currently collect a dedicated fingerprint hash.
  const ownerAgents = collectSessionValues(ownerSessions, (s) => [s.userAgent])
  const referredAgents = collectSessionValues(referredSessions, (s) => [
    s.userAgent,
  ])
  const sharedAgents = [...ownerAgents].filter((ua) => referredAgents.has(ua))

  if (sharedAgents.length > 0) {
    signals.push({
      reason: 'shared_device_fingerprint',
      detail: `${sharedAgents.length} shared device/user-agent fingerprint(s) between referrer and referred account`,
    })
  }

  return { suspicious: signals.length > 0, signals }
}

function generateCandidateCode(): string {
  const bytes = randomBytes(CODE_LENGTH)
  let out = ''
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length]
  }
  return out
}

/**
 * Return the caller's referral code, creating one on first request. Idempotent:
 * repeated calls return the same code (ownerUserId is unique).
 */
export async function getOrCreateReferralCode(
  userId: string,
  database: Db = db
): Promise<{ code: string; createdAt: Date }> {
  const existing = await (database as any).referralCode.findUnique({
    where: { ownerUserId: userId },
  })
  if (existing) return { code: existing.code, createdAt: existing.createdAt }

  // Retry on the (astronomically unlikely) code collision.
  for (let attempt = 0; attempt < CODE_MAX_ATTEMPTS; attempt++) {
    const code = generateCandidateCode()
    try {
      const created = await (database as any).referralCode.create({
        data: { ownerUserId: userId, code },
      })
      logger.info('[Referral] Code created', { userId, code })
      return { code: created.code, createdAt: created.createdAt }
    } catch (err) {
      // Unique violation: another request created the owner's row, or the code
      // collided. Re-read the owner row; if present, return it.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const raced = await (database as any).referralCode.findUnique({
          where: { ownerUserId: userId },
        })
        if (raced) return { code: raced.code, createdAt: raced.createdAt }
        continue // code collision — try a fresh candidate
      }
      throw err
    }
  }
  throw new Error('[Referral] Failed to generate a unique referral code')
}

/**
 * Attribute a newly-created user to a referral code at signup time. Creates a
 * PENDING ReferralConversion so there is an audit trail of "referred but not yet
 * activated". Runs fraud checks and blocks/flags suspicious referrals.
 *
 * Silently no-ops (returns null) on any condition that should not hard-fail signup:
 *   - unknown / malformed code
 *   - self-referral (owner referring themselves)
 *   - referred user already attributed (referredUserId is unique)
 *
 * Fraud checks (#490):
 *   - Blocks if riskScore >= 100 (definite fraud)
 *   - Creates conversion with manualReviewRequired=true if riskScore >= 80
 *   - Logs fraud flags for monitoring
 *
 * @returns the conversion id, or null if no attribution was made.
 */
export async function attributeSignup(
  referredUserId: string,
  rawCode: string,
  database: Db = db
): Promise<string | null> {
  const code = rawCode.trim().toUpperCase()
  if (!code) return null

  const referralCode = await (database as any).referralCode.findUnique({
    where: { code },
  })
  if (!referralCode) {
    logger.warn('[Referral] Signup referral code not found — ignoring', {
      code,
      referredUserId,
    })
    return null
  }

  // Block self-referral: owner cannot refer their own account.
  if (referralCode.ownerUserId === referredUserId) {
    logger.warn('[Referral] Self-referral blocked', { referredUserId, code })
    return null
  }

  // Block circular referral cycles of length <= 3 (#363)
  const circular = await detectCircularReferral(
    referralCode.ownerUserId,
    referredUserId,
    database
  )
  if (circular.isCircular) {
    logger.warn('[Referral] Circular referral blocked', {
      referredUserId,
      ownerUserId: referralCode.ownerUserId,
      chain: circular.chain,
    })
    return null
  }

  // Run fraud detection checks (#490)
  const fraudCheck = await checkReferralFraud(
    referredUserId,
    referralCode.id,
    database
  )

  if (!fraudCheck.passed) {
    logger.warn('[Referral] Fraud check failed — attribution blocked', {
      referredUserId,
      code,
      riskScore: fraudCheck.riskScore,
      flags: fraudCheck.flags,
    })
    await alertingService.emit({
      title: 'Referral fraud detected',
      description: `Referral attribution blocked for user ${referredUserId}. Risk score: ${fraudCheck.riskScore}. Flags: ${fraudCheck.flags.join(', ')}`,
      severity: 'warning',
      component: 'referral-fraud',
      dedupKey: `referral-fraud-${referredUserId}`,
    })
    return null
  }

  try {
    const conversion = await (database as any).referralConversion.create({
      data: {
        referralCodeId: referralCode.id,
        referredUserId,
        status: ReferralStatus.PENDING,
        fraudCheckScore: fraudCheck.riskScore,
        fraudCheckFlags: fraudCheck.flags,
        manualReviewRequired: fraudCheck.requiresManualReview,
        fraudCheckDetails: fraudCheck.details,
      },
    })
    logger.info('[Referral] Signup attributed', {
      referredUserId,
      code,
      conversionId: conversion.id,
      fraudCheckScore: fraudCheck.riskScore,
      manualReviewRequired: fraudCheck.requiresManualReview,
    })

    if (fraudCheck.requiresManualReview) {
      await alertingService.emit({
        title: 'Referral requires manual review',
        description: `Referral conversion ${conversion.id} flagged for manual review. Risk score: ${fraudCheck.riskScore}. Flags: ${fraudCheck.flags.join(', ')}`,
        severity: 'info',
        component: 'referral-fraud',
        dedupKey: `referral-review-${conversion.id}`,
      })
    }

    return conversion.id
  } catch (err) {
    // referredUserId unique violation — user already credited to a referral.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      logger.warn(
        '[Referral] User already attributed to a referral — ignoring',
        {
          referredUserId,
        }
      )
      return null
    }
    throw err
  }
}

/**
 * Called from the confirmed-deposit path (handleDepositEvent) INSIDE the deposit
 * DB transaction. If the depositing user has a PENDING conversion and this
 * confirmed deposit crosses the activation threshold on its own (single-deposit
 * policy), evaluates fraud/abuse heuristics (#397) and either:
 *   - marks the conversion ACTIVATED and pins activationTxId to this real,
 *     confirmed Transaction (clean case — unchanged from before #397), or
 *   - marks it FLAGGED with the triggering signals for manual review, WITHOUT
 *     activating — see resolveFlaggedConversion for how a flagged conversion
 *     is later approved or rejected by an admin.
 * Does not pay out — the payout job only ever sweeps ACTIVATED conversions.
 *
 * Must never throw for referral reasons: a referral bookkeeping problem must not
 * roll back the deposit itself. Any error is logged and swallowed.
 *
 * @param transactionId  the confirmed deposit Transaction.id
 * @param depositAmount  the deposit amount (asset units)
 */
export async function checkAndActivateOnDeposit(
  referredUserId: string,
  transactionId: string,
  depositAmount: Decimal | string | number,
  database: Db = db
): Promise<void> {
  try {
    const conversion = await (database as any).referralConversion.findUnique({
      where: { referredUserId },
      include: { referralCode: true },
    })
    if (!conversion || conversion.status !== ReferralStatus.PENDING) return

    const amount = new Decimal(depositAmount)
    const threshold = new Decimal(config.referral.minActivationDeposit)

    // Single-deposit policy: one confirmed deposit must cross the threshold on
    // its own. Documented in docs/REFERRAL_PROGRAM.md.
    if (amount.lessThan(threshold)) return

    const now = new Date()
    const holdHours = config.referral.minHoldWindowHours ?? 24
    const holdUntil = new Date(now.getTime() + holdHours * 3600_000)

    // Compute tiered reward (#363) against active schedule, referrer's activated
    // count, and monthly cap.
    const schedule = await getActiveRewardSchedule(database)
    const monthStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0)
    )
    let priorActivationsCount = 0
    let earnedThisMonth = 0
    try {
      const priorConversions =
        await (database as any).referralConversion.findMany?.({
          where: {
            referralCodeId: conversion.referralCodeId ?? conversion.referralCode?.id,
            status: { in: [ReferralStatus.ACTIVATED, ReferralStatus.REWARDED] },
          },
          select: {
            activatedAt: true,
            calculatedOwnerReward: true,
          },
        })
      if (Array.isArray(priorConversions)) {
        priorActivationsCount = priorConversions.length
        for (const pc of priorConversions) {
          if (pc.activatedAt && new Date(pc.activatedAt) >= monthStart) {
            earnedThisMonth += Number(
              pc.calculatedOwnerReward ?? config.referral.ownerReward ?? 0
            )
          }
        }
      }
    } catch {
      priorActivationsCount = 0
      earnedThisMonth = 0
    }

    const rewardCalc = calculateTieredReferralReward({
      qualifyingDepositAmount: amount.toNumber(),
      activatedConversionsCount: priorActivationsCount + 1,
      earnedThisMonth,
      schedule,
    })

    const [ownerSessions, referredSessions] = await Promise.all([
      (database as any).session?.findMany?.({
        where: { userId: conversion.referralCode.ownerUserId },
        select: { ipAddress: true, lastSeenIp: true, userAgent: true },
      }) ?? [],
      (database as any).session?.findMany?.({
        where: { userId: referredUserId },
        select: { ipAddress: true, lastSeenIp: true, userAgent: true },
      }) ?? [],
    ])

    const signals: ReferralFraudSignal[] = []
    const ownerIps = collectSessionValues(ownerSessions, (s) => [
      s.ipAddress,
      s.lastSeenIp,
    ])
    const referredIps = collectSessionValues(referredSessions, (s) => [
      s.ipAddress,
      s.lastSeenIp,
    ])
    const sharedIps = [...ownerIps].filter((ip) => referredIps.has(ip))
    if (sharedIps.length > 0) {
      signals.push({
        reason: 'shared_ip',
        detail: `${sharedIps.length} shared IP address(es) between referrer and referred account`,
      })
    }
    const ownerAgents = collectSessionValues(ownerSessions, (s) => [
      s.userAgent,
    ])
    const referredAgents = collectSessionValues(referredSessions, (s) => [
      s.userAgent,
    ])
    const sharedAgents = [...ownerAgents].filter((ua) =>
      referredAgents.has(ua)
    )
    if (sharedAgents.length > 0) {
      signals.push({
        reason: 'shared_device_fingerprint',
        detail: `${sharedAgents.length} shared device/user-agent fingerprint(s) between referrer and referred account`,
      })
    }
    const risk: ReferralFraudAssessment = {
      suspicious: signals.length > 0,
      signals,
    }

    // Evaluate #363 6-signal Sybil & abuse detector (fail-closed to AUTO_REVIEW on error)
    let abuseRiskScore = 0
    let abuseReasons: string[] = []
    let abuseModelVersion = config.referral.sybil?.modelVersion ?? 'sybil-v1'
    let payoutHold: PayoutHoldState = 'NONE'

    try {
      const abuseEval = await evaluateAbuseSignals({
        conversionId: conversion.id,
        referralCodeId:
          conversion.referralCodeId ?? conversion.referralCode?.id ?? '',
        ownerUserId: conversion.referralCode.ownerUserId,
        referredUserId,
        qualifyingDepositAmount: amount.toNumber(),
        activationTxId: transactionId,
        activatedAt: now,
        now,
        preloadedSessions: { ownerSessions, referredSessions },
        database,
      })
      abuseRiskScore = abuseEval.abuseRiskScore
      abuseReasons = abuseEval.abuseReasons
      abuseModelVersion = abuseEval.modelVersion
      payoutHold = abuseEval.payoutHold
    } catch (scorerErr) {
      // Fail-closed invariant (#363): if the abuse scorer errors out during
      // activation, default to payoutHold = AUTO_REVIEW, never NONE.
      logger.error(
        '[Referral] Abuse scorer failed — failing closed to AUTO_REVIEW',
        {
          conversionId: conversion.id,
          error:
            scorerErr instanceof Error ? scorerErr.message : String(scorerErr),
        }
      )
      abuseRiskScore = config.referral.sybil?.holdThreshold ?? 40
      abuseReasons = ['scorer_error_fail_closed']
      payoutHold = 'AUTO_REVIEW'
    }

    const tieredFields = {
      scheduleVersion: rewardCalc.scheduleVersion,
      referrerMilestoneTier: rewardCalc.referrerMilestoneTier,
      qualifyingDepositAmount: new Decimal(rewardCalc.qualifyingDepositAmount),
      calculatedOwnerReward: new Decimal(rewardCalc.calculatedOwnerReward),
      calculatedReferredReward: new Decimal(rewardCalc.calculatedReferredReward),
      rewardCapped: rewardCalc.rewardCapped,
      capReason: rewardCalc.capReason,
      abuseRiskScore,
      abuseReasons,
      abuseModelVersion,
      holdUntil,
    }

    if (risk.suspicious) {
      const reasons = risk.signals.map((s) => s.reason)

      await (database as any).referralConversion.update({
        where: { id: conversion.id },
        data: {
          status: ReferralStatus.FLAGGED,
          fraudReasons: reasons,
          flaggedAt: now,
          // Kept so a reviewer can see which deposit would have activated
          // this — resolveFlaggedConversion sets activatedAt on approval.
          activationTxId: transactionId,
          ...tieredFields,
          payoutHold: payoutHold === 'DENIED' ? 'DENIED' : 'AUTO_REVIEW',
        },
      })

      logger.warn(
        '[Referral] Conversion flagged for manual review — not activated',
        {
          conversionId: conversion.id,
          referredUserId,
          transactionId,
          reasons,
          abuseRiskScore,
          abuseReasons,
        }
      )

      await alertingService
        .emit(
          {
            title: 'Referral conversion flagged for review',
            description: `Conversion ${conversion.id} was not auto-activated: ${risk.signals
              .map((s) => s.detail)
              .join('; ')}.`,
            severity: 'warning',
            component: 'referral-fraud',
            metadata: { conversionId: conversion.id, referredUserId, reasons },
          },
          `referral:fraud:${conversion.id}`
        )
        .catch(() => {})

      return
    }

    await (database as any).referralConversion.update({
      where: { id: conversion.id },
      data: {
        status: ReferralStatus.ACTIVATED,
        activatedAt: now,
        activationTxId: transactionId,
        ...tieredFields,
        payoutHold,
      },
    })

    if (payoutHold === 'DENIED') {
      logger.warn('[Referral Security] Conversion payout denied by Sybil model', {
        conversionId: conversion.id,
        referredUserId,
        ownerUserId: conversion.referralCode.ownerUserId,
        abuseRiskScore,
        abuseReasons,
        abuseModelVersion,
      })
      await alertingService
        .emit(
          {
            title: 'Referral conversion denied by Sybil detector',
            description: `Conversion ${conversion.id} denied (score=${abuseRiskScore}, reasons=${abuseReasons.join(', ')}).`,
            severity: 'warning',
            component: 'referral-sybil',
            metadata: {
              conversionId: conversion.id,
              referredUserId,
              abuseRiskScore,
              abuseReasons,
            },
          },
          `referral:sybil-deny:${conversion.id}`
        )
        .catch(() => {})
    } else if (payoutHold === 'AUTO_REVIEW') {
      logger.warn('[Referral] Conversion placed on AUTO_REVIEW payout hold', {
        conversionId: conversion.id,
        referredUserId,
        abuseRiskScore,
        abuseReasons,
      })
      await alertingService
        .emit(
          {
            title: 'Referral conversion held for Sybil review',
            description: `Conversion ${conversion.id} held in AUTO_REVIEW (score=${abuseRiskScore}, reasons=${abuseReasons.join(', ')}).`,
            severity: 'info',
            component: 'referral-sybil',
            metadata: {
              conversionId: conversion.id,
              referredUserId,
              abuseRiskScore,
              abuseReasons,
            },
          },
          `referral:sybil-hold:${conversion.id}`
        )
        .catch(() => {})
    } else {
      logger.info('[Referral] Conversion activated by confirmed deposit', {
        conversionId: conversion.id,
        referredUserId,
        transactionId,
        amount: amount.toString(),
        scheduleVersion: rewardCalc.scheduleVersion,
        referrerMilestoneTier: rewardCalc.referrerMilestoneTier,
        calculatedOwnerReward: rewardCalc.calculatedOwnerReward,
        calculatedReferredReward: rewardCalc.calculatedReferredReward,
      })
    }
  } catch (err) {
    // Never let referral bookkeeping roll back the deposit.
    logger.error('[Referral] Activation check failed (deposit unaffected)', {
      referredUserId,
      transactionId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Resolve a FLAGGED conversion (#397) — the only way one leaves the FLAGGED
 * state. 'approve' activates it exactly as checkAndActivateOnDeposit would
 * have absent the fraud signal (activatedAt set now, activationTxId already
 * pinned from the flagging deposit); 'reject' moves it to EXPIRED so it can
 * never be paid out. Throws if the conversion doesn't exist or isn't
 * currently FLAGGED — callers (e.g. the admin route) should surface that as
 * a 404/409 rather than silently no-op, since this is an explicit human
 * decision.
 */
export async function resolveFlaggedConversion(
  conversionId: string,
  decision: 'approve' | 'reject',
  reviewerId?: string
): Promise<void> {
  const conversion = await db.referralConversion.findUnique({
    where: { id: conversionId },
  })
  if (!conversion) {
    throw new Error(`Referral conversion ${conversionId} not found`)
  }
  if (conversion.status !== ReferralStatus.FLAGGED) {
    throw new Error(
      `Referral conversion ${conversionId} is not flagged for review (status=${conversion.status})`
    )
  }

  if (decision === 'approve') {
    await db.referralConversion.update({
      where: { id: conversionId },
      data: {
        status: ReferralStatus.ACTIVATED,
        activatedAt: new Date(),
        reviewedAt: new Date(),
        reviewedBy: reviewerId ?? null,
        reviewDecision: 'approved',
      },
    })
    logger.info('[Referral] Flagged conversion approved by reviewer', {
      conversionId,
      reviewerId,
    })
    return
  }

  await db.referralConversion.update({
    where: { id: conversionId },
    data: {
      status: ReferralStatus.EXPIRED,
      reviewedAt: new Date(),
      reviewedBy: reviewerId ?? null,
      reviewDecision: 'rejected',
    },
  })
  logger.info('[Referral] Flagged conversion rejected by reviewer', {
    conversionId,
    reviewerId,
  })
}

/** Resolve the on-chain wallet address a reward should be paid to. */
async function resolveRewardAddress(userId: string): Promise<string | null> {
  // Prefer the custodial wallet (rewards are paid to the address the platform
  // controls the funding path for); fall back to the user's login wallet.
  const wallet = await getWalletByUserId(userId)
  if (wallet?.publicKey) return wallet.publicKey

  const user = await db.user.findUnique({ where: { id: userId } })
  return user?.walletAddress ?? null
}

/**
 * Pay one reward leg through the durable outbox (#325) and record it as a
 * distinctly-typed REFERRAL_REWARD Transaction. Returns the Transaction.id,
 * or throws so the caller leaves the conversion retriable.
 *
 * The Transaction row and its OutboxOp intent are written in the same DB
 * transaction — a crash between "persisted" and "submitted" leaves a durable,
 * retriable record instead of nothing (idempotency key:
 * REFERRAL_REWARD:<recipientUserId>:<conversionId>:<leg>, so re-running this
 * for the same conversion leg is safe).
 */
async function payOneReward(
  recipientUserId: string,
  amount: number,
  network: Network,
  conversionId: string,
  leg: 'owner' | 'referred' | 'tier2'
): Promise<string> {
  const address = await resolveRewardAddress(recipientUserId)
  if (!address) {
    throw new Error(`No wallet address for reward recipient ${recipientUserId}`)
  }

  const asset = config.referral.rewardAsset

  const pending = await db.$transaction(async (tx) => {
    const transaction = await tx.transaction.create({
      data: {
        userId: recipientUserId,
        type: TransactionType.REFERRAL_REWARD,
        status: TransactionStatus.PENDING,
        assetSymbol: asset,
        amount: new Decimal(amount),
        network,
        memo: 'Referral reward',
      },
    })

    const op = await enqueueOutboxOp(tx, {
      idempotencyKey: deriveIdempotencyKey(
        'REFERRAL_REWARD',
        recipientUserId,
        `${conversionId}:${leg}`
      ),
      userId: recipientUserId,
      kind: 'REFERRAL_REWARD',
      actor: 'SYSTEM',
      payload: {
        method: 'referral_reward',
        transactionId: transaction.id,
        recipientAddress: address,
        amount,
        assetSymbol: asset,
        conversionId,
        leg,
      },
    })

    return { transaction, opId: op.id }
  })

  try {
    const result = await dispatchOne(pending.opId)
    const succeeded = !result.status || result.status === 'success'
    const stillPending = result.status === 'pending'
    await db.transaction.update({
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
      throw new Error('On-chain reward submission returned status=failed')
    }
    return pending.transaction.id
  } catch (err) {
    await db.transaction
      .update({
        where: { id: pending.transaction.id },
        data: { status: TransactionStatus.FAILED },
      })
      .catch(() => {})
    throw err
  }
}

/**
 * Sweep ACTIVATED conversions that have not been fully paid out and pay both
 * legs (referrer + referred, per config). Idempotent and retriable: each leg is
 * skipped if already recorded, so a partial failure resumes cleanly on the next
 * run. A conversion only advances to REWARDED once every owed leg has a payout
 * Transaction — otherwise it stays ACTIVATED with payoutError set (visible and
 * retriable), never silently lost.
 */
export async function payoutActivatedConversions(): Promise<{
  scanned: number
  rewarded: number
}> {
  const pending = await db.referralConversion.findMany({
    where: {
      status: ReferralStatus.ACTIVATED,
      // Skip conversions that require manual review or were rejected (#490)
      manualReviewRequired: false,
      manualReviewRejected: false,
    },
    orderBy: { activatedAt: 'asc' },
    take: 200,
    include: { referralCode: true },
  })

  let rewarded = 0
  const now = new Date()
  for (const conversion of pending) {
    const convAny = conversion as any

    // Fail-closed invariant (#363): refuse to pay any conversion whose
    // abuseRiskScore is explicitly null.
    if ('abuseRiskScore' in convAny && convAny.abuseRiskScore === null) {
      await db.referralConversion.update({
        where: { id: conversion.id },
        data: {
          payoutHold: 'AUTO_REVIEW',
          abuseReasons: ['unscored_conversion_fail_closed'],
        } as any,
      })
      logger.warn(
        '[Referral] Refused payout for unscored conversion — routed to AUTO_REVIEW',
        { conversionId: conversion.id }
      )
      continue
    }

    // Gate on payoutHold === 'NONE' (#363)
    if (convAny.payoutHold && convAny.payoutHold !== 'NONE') {
      continue
    }

    // Gate on holdUntil <= now (#363)
    if (
      convAny.holdUntil &&
      new Date(convAny.holdUntil).getTime() > now.getTime()
    ) {
      continue
    }

    // Re-check deposit_then_withdraw before releasing payout (#363)
    if (
      convAny.qualifyingDepositAmount != null &&
      Number(convAny.qualifyingDepositAmount) > 0
    ) {
      const dtw = await checkDepositThenWithdraw({
        referredUserId: conversion.referredUserId,
        qualifyingDepositAmount: Number(convAny.qualifyingDepositAmount),
        since: conversion.activatedAt ?? new Date(0),
        database: db,
      })
      if (dtw.triggered) {
        const existingReasons = Array.isArray(convAny.abuseReasons)
          ? (convAny.abuseReasons as string[])
          : []
        const updatedReasons = existingReasons.includes('deposit_then_withdraw')
          ? existingReasons
          : [...existingReasons, 'deposit_then_withdraw']
        await db.referralConversion.update({
          where: { id: conversion.id },
          data: {
            payoutHold: 'AUTO_REVIEW',
            abuseReasons: updatedReasons,
          } as any,
        })
        logger.warn(
          '[Referral] Deposit withdrawn during hold window — escalated to AUTO_REVIEW',
          {
            conversionId: conversion.id,
            referredUserId: conversion.referredUserId,
            withdrawnRatio: dtw.withdrawnRatio,
          }
        )
        await alertingService
          .emit(
            {
              title: 'Referral deposit-then-withdraw detected at payout time',
              description: `Conversion ${conversion.id} escalated to AUTO_REVIEW (withdrawnRatio=${dtw.withdrawnRatio.toFixed(2)}).`,
              severity: 'warning',
              component: 'referral-sybil',
              metadata: {
                conversionId: conversion.id,
                withdrawnRatio: dtw.withdrawnRatio,
              },
            },
            `referral:dtw-hold:${conversion.id}`
          )
          .catch(() => {})
        continue
      }
    }

    const ownerUserId = conversion.referralCode.ownerUserId
    const referredUserId = conversion.referredUserId

    // Network for the payout Transaction rows — take the referred user's.
    const referredUser = await db.user.findUnique({
      where: { id: referredUserId },
      select: { network: true },
    })
    const network = referredUser?.network ?? Network.MAINNET

    let { ownerRewardTxId, referredRewardTxId, tier2RewardTxId } = conversion
    let hadError = false

    const ownerRewardAmount =
      convAny.calculatedOwnerReward != null
        ? Number(convAny.calculatedOwnerReward)
        : config.referral.ownerReward
    const referredRewardAmount =
      convAny.calculatedReferredReward != null
        ? Number(convAny.calculatedReferredReward)
        : config.referral.referredReward

    // Owner leg.
    if (!ownerRewardTxId && ownerRewardAmount > 0) {
      try {
        ownerRewardTxId = await payOneReward(
          ownerUserId,
          ownerRewardAmount,
          network,
          conversion.id,
          'owner'
        )
        await db.referralConversion.update({
          where: { id: conversion.id },
          data: { ownerRewardTxId, payoutError: null },
        })
      } catch (err) {
        hadError = true
        await recordPayoutFailure(conversion.id, 'owner', err)
      }
    }

    // Referred leg (only if configured to reward the referred user).
    if (!referredRewardTxId && referredRewardAmount > 0) {
      try {
        referredRewardTxId = await payOneReward(
          referredUserId,
          referredRewardAmount,
          network,
          conversion.id,
          'referred'
        )
        await db.referralConversion.update({
          where: { id: conversion.id },
          data: { referredRewardTxId, payoutError: null },
        })
      } catch (err) {
        hadError = true
        await recordPayoutFailure(conversion.id, 'referred', err)
      }
    }

    if (
      !tier2RewardTxId &&
      config.referral.tier2Enabled &&
      config.referral.tier2Reward > 0
    ) {
      const parentCode = await db.referralCode.findFirst({
        where: { ownerUserId: ownerUserId },
        select: { ownerUserId: true },
      })
      // A tier-2 relationship is represented by the owner's own active code
      // being attributed to its parent; inactive/deleted codes earn nothing.
      const parentConversion =
        parentCode &&
        (await db.referralConversion.findFirst({
          where: {
            referralCode: { ownerUserId: { not: ownerUserId } },
            referredUserId: ownerUserId,
            status: { in: [ReferralStatus.ACTIVATED, ReferralStatus.REWARDED] },
          },
          include: { referralCode: true },
        }))
      const tier2Owner = parentConversion?.referralCode.ownerUserId
      if (tier2Owner) {
        try {
          tier2RewardTxId = await payOneReward(
            tier2Owner,
            config.referral.tier2Reward,
            network,
            conversion.id,
            'tier2'
          )
          await db.referralConversion.update({
            where: { id: conversion.id },
            data: { tier2RewardTxId, payoutError: null },
          })
        } catch (err) {
          hadError = true
          await recordPayoutFailure(conversion.id, 'tier2', err)
        }
      }
    }

    if (hadError) continue // stays ACTIVATED — retried next sweep

    const rewardTransactionIds = [
      ownerRewardAmount > 0 ? ownerRewardTxId : null,
      referredRewardAmount > 0 ? referredRewardTxId : null,
    ].filter((id): id is string => id !== null)
    if (rewardTransactionIds.length > 0) {
      const rewardTransactions = await db.transaction.findMany({
        where: { id: { in: rewardTransactionIds } },
        select: { id: true, status: true },
      })
      if (
        rewardTransactions.length !== rewardTransactionIds.length ||
        rewardTransactions.some(
          (transaction) => transaction.status !== 'CONFIRMED'
        )
      ) {
        continue
      }
    }

    // Every owed leg is now paid. Advance to REWARDED (terminal).
    await db.referralConversion.update({
      where: { id: conversion.id },
      data: { status: ReferralStatus.REWARDED, payoutError: null },
    })
    rewarded++
    logger.info('[Referral] Conversion fully rewarded', {
      conversionId: conversion.id,
      ownerRewardTxId,
      referredRewardTxId,
    })
  }

  return { scanned: pending.length, rewarded }
}

async function recordPayoutFailure(
  conversionId: string,
  leg: 'owner' | 'referred' | 'tier2',
  err: unknown
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err)
  logger.error('[Referral] Reward payout failed — conversion left retriable', {
    conversionId,
    leg,
    error: message,
  })
  await db.referralConversion
    .update({
      where: { id: conversionId },
      data: { payoutError: `${leg}: ${message}`.slice(0, 500) },
    })
    .catch(() => {})

  await alertingService
    .emit(
      {
        title: 'Referral reward payout failed',
        description: `Payout of the ${leg} leg for referral conversion ${conversionId} failed: ${message}. The conversion remains ACTIVATED and will be retried.`,
        severity: 'warning',
        component: 'referral-payout',
        metadata: { conversionId, leg },
      },
      `referral:payout:${conversionId}:${leg}`
    )
    .catch(() => {})
}

/**
 * List the caller's referrals (conversions attributed to their code), newest
 * first. Used by GET /referrals/:userId.
 */
export async function listReferrals(ownerUserId: string) {
  const referralCode = await db.referralCode.findUnique({
    where: { ownerUserId },
    include: {
      conversions: {
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          status: true,
          activatedAt: true,
          activationTxId: true,
          ownerRewardTxId: true,
          referredRewardTxId: true,
          createdAt: true,
        },
      },
    },
  })

  return {
    code: referralCode?.code ?? null,
    referrals: referralCode?.conversions ?? [],
  }
}

/**
 * Approve a referral conversion that was flagged for manual review (#490).
 * Clears the manual review flag so payout can proceed.
 */
export async function approveReferralConversion(
  conversionId: string,
  reviewedBy: string
): Promise<void> {
  const conversion = await db.referralConversion.findUnique({
    where: { id: conversionId },
  })

  if (!conversion) {
    throw new Error(`Referral conversion ${conversionId} not found`)
  }

  if (!conversion.manualReviewRequired) {
    throw new Error(`Conversion ${conversionId} does not require manual review`)
  }

  await db.referralConversion.update({
    where: { id: conversionId },
    data: {
      manualReviewRequired: false,
      reviewedBy,
      reviewedAt: new Date(),
    },
  })

  logger.info('[Referral] Conversion approved after manual review', {
    conversionId,
    reviewedBy,
  })
}

/**
 * Reject a referral conversion that was flagged for manual review (#490).
 * Blocks payout permanently.
 */
export async function rejectReferralConversion(
  conversionId: string,
  reviewedBy: string,
  rejectionReason: string
): Promise<void> {
  const conversion = await db.referralConversion.findUnique({
    where: { id: conversionId },
  })

  if (!conversion) {
    throw new Error(`Referral conversion ${conversionId} not found`)
  }

  await db.referralConversion.update({
    where: { id: conversionId },
    data: {
      manualReviewRequired: false,
      manualReviewRejected: true,
      reviewedBy,
      reviewedAt: new Date(),
      rejectionReason,
    },
  })

  logger.warn('[Referral] Conversion rejected after manual review', {
    conversionId,
    reviewedBy,
    reason: rejectionReason,
  })
}

/**
 * List referral conversions requiring manual review (#490).
 */
export async function listConversionsForReview(): Promise<any[]> {
  return db.referralConversion.findMany({
    where: {
      manualReviewRequired: true,
      manualReviewRejected: false,
    },
    include: {
      referralCode: {
        include: {
          owner: {
            select: {
              id: true,
              walletAddress: true,
              email: true,
              createdAt: true,
            },
          },
        },
      },
      referredUser: {
        select: {
          id: true,
          walletAddress: true,
          email: true,
          createdAt: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  })
}

/**
 * Alias of listConversionsForReview — exported under the name expected by
 * the admin routes that were added alongside fraud-detection (#490).
 */
export const listFlaggedConversions = listConversionsForReview

/**
 * Referral leaderboard: top referrers by confirmed conversion count.
 * Returns users sorted by number of accepted referrals, paginated.
 */
export async function referralLeaderboard(
  page: number = 1,
  limit: number = 20,
  includeDisplayName: boolean = false
): Promise<
  {
    ownerId: string
    code: string
    conversions: number
    displayName?: string | null
  }[]
> {
  const codes = await db.referralCode.findMany({
    include: {
      owner: includeDisplayName
        ? {
            select: {
              displayName: true,
            },
          }
        : false,
      _count: {
        select: {
          conversions: {
            where: { status: 'ACTIVATED' },
          },
        },
      },
    },
    orderBy: { conversions: { _count: 'desc' } },
    skip: (page - 1) * limit,
    take: limit,
  })

  return codes.map((c) => ({
    ownerId: c.ownerUserId,
    code: c.code,
    conversions: c._count.conversions,
    ...(includeDisplayName
      ? { displayName: (c as any).owner?.displayName ?? null }
      : {}),
  }))
}

/**
 * GET /api/v1/referrals/me summary (#363).
 *
 * Exposes the referrer's active milestone tier, progress toward the next
 * milestone, active reward schedule, monthly cap usage, and each conversion's
 * status and hold countdown — while never leaking DENIED reasons (shown only
 * as 'NOT_ELIGIBLE' so attackers cannot probe the Sybil model).
 */
export async function getReferralMeSummary(
  userId: string,
  database: Db = db
) {
  const [schedule, referralCode] = await Promise.all([
    getActiveRewardSchedule(database),
    (database as any).referralCode.findUnique({
      where: { ownerUserId: userId },
      include: {
        conversions: {
          orderBy: { createdAt: 'desc' },
        },
      },
    }),
  ])

  const conversions: any[] = referralCode?.conversions ?? []
  const now = new Date()
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0)
  )

  const activatedCount = conversions.filter(
    (c) =>
      (c.status === ReferralStatus.ACTIVATED ||
        c.status === ReferralStatus.REWARDED) &&
      c.payoutHold !== 'DENIED'
  ).length

  const milestone = resolveMilestoneTier(activatedCount, schedule.milestoneTiers)

  let earnedThisMonth = 0
  for (const c of conversions) {
    if (
      (c.status === ReferralStatus.ACTIVATED ||
        c.status === ReferralStatus.REWARDED) &&
      c.payoutHold !== 'DENIED' &&
      c.activatedAt &&
      new Date(c.activatedAt) >= monthStart
    ) {
      earnedThisMonth += Number(
        c.calculatedOwnerReward ?? config.referral.ownerReward ?? 0
      )
    }
  }

  return {
    code: referralCode?.code ?? null,
    schedule: {
      version: schedule.version,
      rewardAsset: config.referral.rewardAsset,
      depositTiers: schedule.depositTiers,
      milestoneTiers: schedule.milestoneTiers,
      maxRewardPerConversion: schedule.maxRewardPerConversion,
      maxRewardPerReferrerPerMonth: schedule.maxRewardPerReferrerPerMonth,
      minHoldWindowHours: schedule.minHoldWindowHours,
    },
    milestoneProgress: {
      currentTier: milestone.currentTier.tier,
      currentLabel: milestone.currentTier.label,
      multiplier: milestone.currentTier.multiplier,
      activatedConversions: activatedCount,
      nextTier: milestone.nextTier
        ? {
            tier: milestone.nextTier.tier,
            label: milestone.nextTier.label,
            multiplier: milestone.nextTier.multiplier,
            minActivatedConversions: milestone.nextTier.minActivatedConversions,
            conversionsRemaining: milestone.conversionsToNextTier,
          }
        : null,
    },
    monthlyCapUsage: {
      earnedThisMonth: Number(earnedThisMonth.toFixed(2)),
      monthlyCap: schedule.maxRewardPerReferrerPerMonth,
      remainingThisMonth: Number(
        Math.max(0, schedule.maxRewardPerReferrerPerMonth - earnedThisMonth).toFixed(2)
      ),
    },
    conversions: conversions.map((c) => {
      const isDenied =
        c.payoutHold === 'DENIED' || c.manualReviewRejected === true
      const isHeldForReview =
        c.payoutHold === 'AUTO_REVIEW' ||
        c.status === ReferralStatus.FLAGGED ||
        c.manualReviewRequired === true

      const holdUntilDate = c.holdUntil ? new Date(c.holdUntil) : null
      const holdRemainingSeconds =
        !isDenied &&
        holdUntilDate &&
        holdUntilDate.getTime() > now.getTime()
          ? Math.ceil((holdUntilDate.getTime() - now.getTime()) / 1000)
          : 0

      let userFacingStatus: string = c.status
      if (isDenied) {
        userFacingStatus = 'NOT_ELIGIBLE'
      } else if (isHeldForReview) {
        userFacingStatus = 'PENDING_REVIEW'
      } else if (
        c.status === ReferralStatus.ACTIVATED &&
        holdRemainingSeconds > 0
      ) {
        userFacingStatus = 'HOLD_WINDOW'
      }

      return {
        id: c.id,
        status: isDenied ? 'NOT_ELIGIBLE' : c.status,
        userFacingStatus,
        scheduleVersion: c.scheduleVersion ?? schedule.version,
        referrerMilestoneTier: c.referrerMilestoneTier ?? milestone.currentTier.tier,
        qualifyingDepositAmount:
          c.qualifyingDepositAmount != null
            ? Number(c.qualifyingDepositAmount)
            : null,
        ownerReward: isDenied
          ? 0
          : c.calculatedOwnerReward != null
            ? Number(c.calculatedOwnerReward)
            : config.referral.ownerReward,
        referredReward: isDenied
          ? 0
          : c.calculatedReferredReward != null
            ? Number(c.calculatedReferredReward)
            : config.referral.referredReward,
        rewardCapped: Boolean(c.rewardCapped),
        capReason: isDenied ? null : c.capReason ?? null,
        holdUntil: isDenied
          ? null
          : holdUntilDate
            ? holdUntilDate.toISOString()
            : null,
        holdRemainingSeconds,
        activatedAt: c.activatedAt ? new Date(c.activatedAt).toISOString() : null,
        createdAt: c.createdAt ? new Date(c.createdAt).toISOString() : null,
      }
    }),
  }
}

/**
 * GET /api/v1/admin/referrals/review (#363).
 *
 * Lists conversions in AUTO_REVIEW (or legacy manualReviewRequired) with their
 * abuseRiskScore, abuseReasons, deposit/withdrawal history summary, and linked
 * accounts.
 */
export async function listAbuseReviewQueue(database: Db = db): Promise<any[]> {
  const conversions = await (database as any).referralConversion.findMany({
    where: {
      OR: [
        { payoutHold: 'AUTO_REVIEW' },
        { manualReviewRequired: true, manualReviewRejected: false },
      ],
    },
    include: {
      referralCode: {
        include: {
          owner: {
            select: {
              id: true,
              walletAddress: true,
              email: true,
              createdAt: true,
            },
          },
        },
      },
      referredUser: {
        select: {
          id: true,
          walletAddress: true,
          email: true,
          createdAt: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  })

  const enriched: any[] = []
  for (const c of Array.isArray(conversions) ? conversions : []) {
    let depositTotal = Number(c.qualifyingDepositAmount ?? 0)
    let withdrawalTotal = 0
    try {
      const txs = await (database as any).transaction?.findMany?.({
        where: {
          userId: c.referredUserId,
          type: { in: ['DEPOSIT', 'WITHDRAWAL'] },
          status: { in: ['CONFIRMED', 'PENDING'] },
        },
        select: { type: true, amount: true },
      })
      if (Array.isArray(txs)) {
        depositTotal = 0
        withdrawalTotal = 0
        for (const tx of txs) {
          if (tx.type === 'DEPOSIT') depositTotal += Number(tx.amount ?? 0)
          if (tx.type === 'WITHDRAWAL') withdrawalTotal += Number(tx.amount ?? 0)
        }
      }
    } catch {}

    enriched.push({
      ...c,
      abuseRiskScore: c.abuseRiskScore ?? c.fraudCheckScore ?? 0,
      abuseReasons:
        Array.isArray(c.abuseReasons) && c.abuseReasons.length > 0
          ? c.abuseReasons
          : c.fraudReasons ?? c.fraudCheckFlags ?? [],
      historySummary: {
        depositTotal,
        withdrawalTotal,
        netRetained: Number((depositTotal - withdrawalTotal).toFixed(2)),
      },
      linkedAccounts: {
        referrerUserId: c.referralCode?.ownerUserId ?? null,
        referredUserId: c.referredUserId,
      },
    })
  }

  return enriched
}

/**
 * POST /api/v1/admin/referrals/review/:id/decision (#363).
 *
 * Accepts { decision: 'RELEASE' | 'DENY', reason: string }, transitions
 * payoutHold to 'NONE' (releasing to the next payout sweep) or 'DENIED', and
 * writes a hash-chained audit entry (#315) recording the reviewer, prior
 * score/reasons, and decision reason.
 */
export async function decideAbuseReviewConversion(
  params: {
    conversionId: string
    decision: 'RELEASE' | 'DENY'
    reason: string
    reviewerId: string
  },
  database: Db = db
): Promise<{
  conversionId: string
  decision: 'RELEASE' | 'DENY'
  payoutHold: PayoutHoldState
  payloadHash: string
}> {
  const { conversionId, decision, reason, reviewerId } = params
  if (!reason || !reason.trim()) {
    throw new Error('Decision reason is required')
  }
  if (decision !== 'RELEASE' && decision !== 'DENY') {
    throw new Error(`Invalid decision: ${decision}`)
  }

  const conversion = await (database as any).referralConversion.findUnique({
    where: { id: conversionId },
  })
  if (!conversion) {
    throw new Error(`Referral conversion ${conversionId} not found`)
  }

  const nextHold: PayoutHoldState = decision === 'RELEASE' ? 'NONE' : 'DENIED'
  const reviewedAt = new Date()

  const auditPayload = {
    kind: 'REFERRAL_REVIEW_DECISION',
    conversionId,
    reviewerId,
    decision,
    reason: reason.trim(),
    priorPayoutHold: conversion.payoutHold ?? 'AUTO_REVIEW',
    priorAbuseRiskScore: conversion.abuseRiskScore ?? null,
    priorAbuseReasons: conversion.abuseReasons ?? [],
    nextPayoutHold: nextHold,
    reviewedAt: reviewedAt.toISOString(),
  }
  const payloadHash = auditPayloadHashFor(auditPayload)

  await (database as any).referralConversion.update({
    where: { id: conversionId },
    data: {
      payoutHold: nextHold,
      status:
        decision === 'RELEASE' && conversion.status === ReferralStatus.FLAGGED
          ? ReferralStatus.ACTIVATED
          : conversion.status,
      activatedAt:
        decision === 'RELEASE' && !conversion.activatedAt
          ? reviewedAt
          : conversion.activatedAt,
      manualReviewRequired: false,
      manualReviewRejected: decision === 'DENY',
      reviewedBy: reviewerId,
      reviewedAt,
      reviewDecision: decision.toLowerCase(),
      reviewNote: reason.trim(),
      rejectionReason: decision === 'DENY' ? reason.trim() : null,
    },
  })

  try {
    await (database as any).auditPayloadHash?.create?.({
      data: {
        tableName: 'referral_conversions',
        kind: 'REFERRAL_REVIEW_DECISION',
        payloadHash,
      },
    })
  } catch (err) {
    logger.error('[Referral] Audit hash persistence failed (non-fatal)', {
      conversionId,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  logger.info('[Referral] Admin abuse review decision recorded', {
    conversionId,
    decision,
    payoutHold: nextHold,
    reviewerId,
    payloadHash,
  })

  return {
    conversionId,
    decision,
    payoutHold: nextHold,
    payloadHash,
  }
}
