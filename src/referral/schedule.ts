/**
 * Tiered Referral Reward Schedule (#363).
 *
 * Replaces flat `REFERRAL_OWNER_REWARD` / `REFERRAL_REFERRED_REWARD` with a
 * versioned schedule `f(referredDepositAmount) * g(referrerLifetimeActivations)`
 * subject to `maxRewardPerConversion` and `maxRewardPerReferrerPerMonth` caps.
 *
 * Each activated `ReferralConversion` stamps the `scheduleVersion` and computed
 * reward legs at activation time so retroactive schedule edits never rewrite
 * historical rewards.
 */
import db from '../db'
import { config } from '../config'

export interface DepositRewardTier {
  minDeposit: number
  maxDeposit: number | null // null = unbounded
  ownerReward: number
  referredReward: number
  ownerBaseReward: number
  referredBaseReward: number
}

export interface ReferrerMilestoneTier {
  tier: number
  name: 'Bronze' | 'Silver' | 'Gold' | string
  label: 'Bronze' | 'Silver' | 'Gold' | string
  minActivations: number
  minActivatedConversions: number
  maxActivations: number | null // null = unbounded
  multiplier: number
}

export interface ReferralRewardScheduleConfig {
  version: string
  scheduleVersion: string
  depositTiers: DepositRewardTier[]
  milestoneTiers: ReferrerMilestoneTier[]
  maxRewardPerConversion: number
  maxRewardPerReferrerPerMonth: number
  minHoldWindowHours: number
}

export const DEFAULT_DEPOSIT_TIERS: DepositRewardTier[] = [
  {
    minDeposit: 10,
    maxDeposit: 99.999999,
    ownerReward: 5,
    referredReward: 5,
    ownerBaseReward: 5,
    referredBaseReward: 5,
  },
  {
    minDeposit: 100,
    maxDeposit: 499.999999,
    ownerReward: 15,
    referredReward: 10,
    ownerBaseReward: 15,
    referredBaseReward: 10,
  },
  {
    minDeposit: 500,
    maxDeposit: 2499.999999,
    ownerReward: 40,
    referredReward: 25,
    ownerBaseReward: 40,
    referredBaseReward: 25,
  },
  {
    minDeposit: 2500,
    maxDeposit: null,
    ownerReward: 100,
    referredReward: 50,
    ownerBaseReward: 100,
    referredBaseReward: 50,
  },
]

export const DEFAULT_MILESTONE_TIERS: ReferrerMilestoneTier[] = [
  {
    tier: 1,
    name: 'Bronze',
    label: 'Bronze',
    minActivations: 0,
    minActivatedConversions: 0,
    maxActivations: 4,
    multiplier: 1.0,
  },
  {
    tier: 2,
    name: 'Silver',
    label: 'Silver',
    minActivations: 5,
    minActivatedConversions: 5,
    maxActivations: 19,
    multiplier: 1.25,
  },
  {
    tier: 3,
    name: 'Gold',
    label: 'Gold',
    minActivations: 20,
    minActivatedConversions: 20,
    maxActivations: null,
    multiplier: 1.5,
  },
]

export const DEFAULT_REFERRAL_SCHEDULE: ReferralRewardScheduleConfig = {
  version: 'v1',
  scheduleVersion: 'v1',
  depositTiers: DEFAULT_DEPOSIT_TIERS,
  milestoneTiers: DEFAULT_MILESTONE_TIERS,
  maxRewardPerConversion: 150,
  maxRewardPerReferrerPerMonth: 1000,
  minHoldWindowHours: 24,
}

export function getDefaultRewardSchedule(): ReferralRewardScheduleConfig {
  const version = config.referral?.scheduleVersion || 'v1'
  return {
    version,
    scheduleVersion: version,
    depositTiers: DEFAULT_DEPOSIT_TIERS,
    milestoneTiers: DEFAULT_MILESTONE_TIERS,
    maxRewardPerConversion: config.referral?.maxRewardPerConversion ?? 150,
    maxRewardPerReferrerPerMonth:
      config.referral?.maxRewardPerReferrerPerMonth ?? 1000,
    minHoldWindowHours: config.referral?.minHoldWindowHours ?? 24,
  }
}

export async function getActiveRewardSchedule(
  database: any = db
): Promise<ReferralRewardScheduleConfig> {
  try {
    const activeRow = await database.referralRewardSchedule?.findFirst?.({
      where: { isActive: true },
      orderBy: { createdAt: 'desc' },
    })
    if (activeRow) {
      const version = activeRow.scheduleVersion || 'v1'
      return {
        version,
        scheduleVersion: version,
        depositTiers: Array.isArray(activeRow.depositTiers)
          ? (activeRow.depositTiers as DepositRewardTier[])
          : DEFAULT_DEPOSIT_TIERS,
        milestoneTiers: Array.isArray(activeRow.milestoneTiers)
          ? (activeRow.milestoneTiers as ReferrerMilestoneTier[])
          : DEFAULT_MILESTONE_TIERS,
        maxRewardPerConversion: Number(activeRow.maxRewardPerConversion),
        maxRewardPerReferrerPerMonth: Number(
          activeRow.maxRewardPerReferrerPerMonth
        ),
        minHoldWindowHours: Number(activeRow.minHoldWindowHours ?? 24),
      }
    }
  } catch {
    // Fallback to default config if table is not populated or mocked out
  }
  return getDefaultRewardSchedule()
}

export function resolveDepositTier(
  depositAmount: number,
  tiers: DepositRewardTier[] = DEFAULT_DEPOSIT_TIERS
): DepositRewardTier {
  const sorted = [...tiers].sort((a, b) => b.minDeposit - a.minDeposit)
  for (const tier of sorted) {
    if (
      depositAmount >= tier.minDeposit &&
      (tier.maxDeposit === null || depositAmount <= tier.maxDeposit)
    ) {
      return tier
    }
  }
  return sorted[sorted.length - 1] ?? DEFAULT_DEPOSIT_TIERS[0]
}

export function resolveMilestoneTier(
  lifetimeActivations: number,
  tiers: ReferrerMilestoneTier[] = DEFAULT_MILESTONE_TIERS
): {
  currentTier: ReferrerMilestoneTier
  nextTier: ReferrerMilestoneTier | null
  activationsToNextTier: number
  conversionsToNextTier: number
} {
  const sorted = [...tiers].sort((a, b) => a.minActivations - b.minActivations)
  let currentTier = sorted[0]
  let currentIndex = 0

  for (let i = 0; i < sorted.length; i++) {
    const tier = sorted[i]
    if (
      lifetimeActivations >= tier.minActivations &&
      (tier.maxActivations === null ||
        lifetimeActivations <= tier.maxActivations)
    ) {
      currentTier = tier
      currentIndex = i
    }
  }

  const nextTier =
    currentIndex + 1 < sorted.length ? sorted[currentIndex + 1] : null
  const activationsToNextTier = nextTier
    ? Math.max(0, nextTier.minActivations - lifetimeActivations)
    : 0

  return {
    currentTier,
    nextTier,
    activationsToNextTier,
    conversionsToNextTier: activationsToNextTier,
  }
}

export interface ComputedTieredReward {
  scheduleVersion: string
  milestoneTier: string
  referrerMilestoneTier: string
  multiplier: number
  qualifyingDepositAmount: number
  ownerReward: number
  referredReward: number
  calculatedOwnerReward: number
  calculatedReferredReward: number
  uncappedOwnerReward: number
  uncappedReferredReward: number
  rewardCapped: boolean
  capReason: 'PER_CONVERSION_CAP' | 'MONTHLY_CAP' | null
}

/**
 * Pure calculation of `f(referredDepositAmount) * g(referrerLifetimeActivations)`
 * with `maxRewardPerConversion` and `maxRewardPerReferrerPerMonth` caps.
 */
export function calculateTieredReferralReward(params: {
  qualifyingDepositAmount?: number
  depositAmount?: number
  activatedConversionsCount?: number
  referrerLifetimeActivations?: number
  earnedThisMonth?: number
  referrerCurrentMonthEarned?: number
  schedule?: ReferralRewardScheduleConfig
}): ComputedTieredReward {
  const schedule = params.schedule ?? getDefaultRewardSchedule()
  const depositAmount =
    params.qualifyingDepositAmount ?? params.depositAmount ?? 0
  const lifetimeActivations =
    params.activatedConversionsCount ?? params.referrerLifetimeActivations ?? 1
  const earnedThisMonth =
    params.earnedThisMonth ?? params.referrerCurrentMonthEarned ?? 0

  const depositTier = resolveDepositTier(depositAmount, schedule.depositTiers)
  const { currentTier } = resolveMilestoneTier(
    lifetimeActivations,
    schedule.milestoneTiers
  )

  const baseOwner = depositTier.ownerReward ?? depositTier.ownerBaseReward
  const baseReferred =
    depositTier.referredReward ?? depositTier.referredBaseReward

  const uncappedOwnerReward = Number(
    (baseOwner * currentTier.multiplier).toFixed(8)
  )
  const uncappedReferredReward = Number(baseReferred.toFixed(8))

  let ownerReward = uncappedOwnerReward
  let referredReward = uncappedReferredReward
  let rewardCapped = false
  let capReason: 'PER_CONVERSION_CAP' | 'MONTHLY_CAP' | null = null

  // 1. Per-conversion cap
  if (ownerReward > schedule.maxRewardPerConversion) {
    ownerReward = Number(schedule.maxRewardPerConversion.toFixed(8))
    rewardCapped = true
    capReason = 'PER_CONVERSION_CAP'
  }
  if (referredReward > schedule.maxRewardPerConversion) {
    referredReward = Number(schedule.maxRewardPerConversion.toFixed(8))
    rewardCapped = true
    capReason = 'PER_CONVERSION_CAP'
  }

  // 2. Per-referrer monthly cap (clamps ownerReward to remaining monthly budget)
  const remainingMonthlyBudget = Math.max(
    0,
    schedule.maxRewardPerReferrerPerMonth - earnedThisMonth
  )
  if (ownerReward > remainingMonthlyBudget) {
    ownerReward = Number(remainingMonthlyBudget.toFixed(8))
    rewardCapped = true
    capReason = 'MONTHLY_CAP'
  }

  return {
    scheduleVersion: schedule.scheduleVersion,
    milestoneTier: currentTier.name,
    referrerMilestoneTier: currentTier.name,
    multiplier: currentTier.multiplier,
    qualifyingDepositAmount: depositAmount,
    ownerReward,
    referredReward,
    calculatedOwnerReward: ownerReward,
    calculatedReferredReward: referredReward,
    uncappedOwnerReward,
    uncappedReferredReward,
    rewardCapped,
    capReason,
  }
}
