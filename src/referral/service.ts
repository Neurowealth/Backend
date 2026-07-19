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
import { payReferralReward } from '../stellar/contract'
import { getWalletByUserId } from '../stellar/wallet'

type Db = typeof db | Prisma.TransactionClient

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no ambiguous 0/O/1/I
const CODE_LENGTH = 8
const CODE_MAX_ATTEMPTS = 5

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
 * activated". Silently no-ops (returns null) on any condition that should not
 * hard-fail signup:
 *   - unknown / malformed code
 *   - self-referral (owner referring themselves)
 *   - referred user already attributed (referredUserId is unique)
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

  try {
    const conversion = await (database as any).referralConversion.create({
      data: {
        referralCodeId: referralCode.id,
        referredUserId,
        status: ReferralStatus.PENDING,
      },
    })
    logger.info('[Referral] Signup attributed', {
      referredUserId,
      code,
      conversionId: conversion.id,
    })
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
 * policy), mark the conversion ACTIVATED and pin activationTxId to this real,
 * confirmed Transaction. Does not pay out — the payout job handles that.
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
    })
    if (!conversion || conversion.status !== ReferralStatus.PENDING) return

    const amount = new Decimal(depositAmount)
    const threshold = new Decimal(config.referral.minActivationDeposit)

    // Single-deposit policy: one confirmed deposit must cross the threshold on
    // its own. Documented in docs/REFERRAL_PROGRAM.md.
    if (amount.lessThan(threshold)) return

    await (database as any).referralConversion.update({
      where: { id: conversion.id },
      data: {
        status: ReferralStatus.ACTIVATED,
        activatedAt: new Date(),
        activationTxId: transactionId,
      },
    })

    logger.info('[Referral] Conversion activated by confirmed deposit', {
      conversionId: conversion.id,
      referredUserId,
      transactionId,
      amount: amount.toString(),
    })
  } catch (err) {
    // Never let referral bookkeeping roll back the deposit.
    logger.error('[Referral] Activation check failed (deposit unaffected)', {
      referredUserId,
      transactionId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
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
 * Pay one reward leg and record it as a distinctly-typed REFERRAL_REWARD
 * Transaction. Returns the Transaction.id, or throws so the caller leaves the
 * conversion retriable.
 */
async function payOneReward(
  recipientUserId: string,
  amount: number,
  network: Network
): Promise<string> {
  const address = await resolveRewardAddress(recipientUserId)
  if (!address) {
    throw new Error(`No wallet address for reward recipient ${recipientUserId}`)
  }

  const asset = config.referral.rewardAsset
  const result = await payReferralReward(address, amount, asset)

  const tx = await db.transaction.create({
    data: {
      userId: recipientUserId,
      txHash: result.hash,
      type: TransactionType.REFERRAL_REWARD,
      status: TransactionStatus.CONFIRMED,
      assetSymbol: asset,
      amount: new Decimal(amount),
      network,
      memo: 'Referral reward',
      confirmedAt: new Date(),
    },
  })
  return tx.id
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
    where: { status: ReferralStatus.ACTIVATED },
    orderBy: { activatedAt: 'asc' },
    take: 200,
    include: { referralCode: true },
  })

  let rewarded = 0
  for (const conversion of pending) {
    const ownerUserId = conversion.referralCode.ownerUserId
    const referredUserId = conversion.referredUserId

    // Network for the payout Transaction rows — take the referred user's.
    const referredUser = await db.user.findUnique({
      where: { id: referredUserId },
      select: { network: true },
    })
    const network = referredUser?.network ?? Network.MAINNET

    let { ownerRewardTxId, referredRewardTxId } = conversion
    let hadError = false

    // Owner leg.
    if (!ownerRewardTxId && config.referral.ownerReward > 0) {
      try {
        ownerRewardTxId = await payOneReward(
          ownerUserId,
          config.referral.ownerReward,
          network
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
    if (!referredRewardTxId && config.referral.referredReward > 0) {
      try {
        referredRewardTxId = await payOneReward(
          referredUserId,
          config.referral.referredReward,
          network
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

    if (hadError) continue // stays ACTIVATED — retried next sweep

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
  leg: 'owner' | 'referred',
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
