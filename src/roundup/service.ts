import db from '../db'
import { config } from '../config'
import { logger } from '../utils/logger'
import { publishUserEvent } from '../events/publisher'
import { EVENT_TYPE_TOPIC } from '../events/types'
import type { UpdateRoundUpSettingsInput } from '../validators/roundup-validators'
import type {
  RoundUpCalculation,
  RoundUpAccrualsResponse,
  RoundUpSettings,
  RoundUpAccrual,
} from './types'

type Db = typeof db

export class TargetGoalNotFoundError extends Error {
  constructor(
    message = 'Target savings goal not found or does not belong to user'
  ) {
    super(message)
    this.name = 'TargetGoalNotFoundError'
  }
}

/**
 * Calculates spare change round-up for a given purchase amount based on
 * the nearest interval and multiplier.
 *
 * @param purchaseAmount - Transaction purchase amount in fiat currency.
 * @param roundToNearest - Increment to round up to (default 1.0).
 * @param multiplier - Boost multiplier clamped between 1.0 and maximum configured (default 1.0).
 * @returns The computed round-up amounts and applied parameters.
 */
export function calculateRoundUp(
  purchaseAmount: number,
  roundToNearest = 1.0,
  multiplier = 1.0
): RoundUpCalculation {
  if (purchaseAmount <= 0) {
    return {
      purchaseAmount: 0,
      roundToNearest,
      multiplier,
      roundUpAmount: 0,
      totalRoundUp: 0,
    }
  }

  const nearest = roundToNearest > 0 ? roundToNearest : 1.0
  const maxMultiplier = config.roundUp?.maxMultiplier ?? 10.0
  const clampedMultiplier = Math.max(1.0, Math.min(multiplier, maxMultiplier))

  const remainder = purchaseAmount % nearest
  const isExactMultiple =
    Math.abs(remainder) < 1e-9 || Math.abs(remainder - nearest) < 1e-9

  let roundUpAmount = 0
  if (!isExactMultiple) {
    const nextMultiple = Math.ceil(purchaseAmount / nearest) * nearest
    roundUpAmount = Math.max(0, nextMultiple - purchaseAmount)
    roundUpAmount = Math.round(roundUpAmount * 100) / 100
  }

  const totalRoundUp = Math.round(roundUpAmount * clampedMultiplier * 100) / 100

  return {
    purchaseAmount: Math.round(purchaseAmount * 100) / 100,
    roundToNearest: nearest,
    multiplier: clampedMultiplier,
    roundUpAmount,
    totalRoundUp,
  }
}

/**
 * Retrieves the round-up savings settings for a user. Returns defaults if not yet created.
 *
 * @param userId - Unique user identifier.
 * @param database - Database client instance.
 * @returns The round-up settings.
 */
export async function getRoundUpSettings(
  userId: string,
  database: Db = db
): Promise<RoundUpSettings> {
  const existing = await (database as any).roundUpSettings.findUnique({
    where: { userId },
  })

  if (existing) {
    return existing
  }

  return {
    id: '',
    userId,
    enabled: false,
    roundToNearest: (config.roundUp?.defaultRoundToNearest ?? 1.0) as any,
    multiplier: 1.0 as any,
    targetGoalId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}

/**
 * Updates or creates round-up settings for a user.
 *
 * @param userId - Unique user identifier.
 * @param input - Desired updates to settings.
 * @param database - Database client instance.
 * @returns The updated settings.
 */
export async function updateRoundUpSettings(
  userId: string,
  input: UpdateRoundUpSettingsInput,
  database: Db = db
): Promise<RoundUpSettings> {
  if (input.targetGoalId) {
    const goal = await (database as any).savingsGoal.findUnique({
      where: { id: input.targetGoalId },
    })
    if (!goal || goal.userId !== userId) {
      throw new TargetGoalNotFoundError()
    }
  }

  const maxMultiplier = config.roundUp?.maxMultiplier ?? 10.0
  const normalizedMultiplier =
    input.multiplier !== undefined
      ? Math.max(1.0, Math.min(input.multiplier, maxMultiplier))
      : undefined

  const data: Record<string, unknown> = {}
  if (input.enabled !== undefined) data.enabled = input.enabled
  if (input.roundToNearest !== undefined)
    data.roundToNearest = input.roundToNearest
  if (normalizedMultiplier !== undefined)
    data.multiplier = normalizedMultiplier
  if (input.targetGoalId !== undefined)
    data.targetGoalId = input.targetGoalId

  return (database as any).roundUpSettings.upsert({
    where: { userId },
    create: {
      userId,
      enabled: input.enabled ?? false,
      roundToNearest:
        input.roundToNearest ?? (config.roundUp?.defaultRoundToNearest ?? 1.0),
      multiplier: normalizedMultiplier ?? 1.0,
      targetGoalId: input.targetGoalId ?? null,
    },
    update: data,
  })
}

/**
 * Accrues round-up spare change when an on-ramp order settles.
 *
 * @param order - Settled fiat order.
 * @param database - Database client instance.
 * @returns The created accrual record or null if not applicable.
 */
export async function accrueRoundUpForOrder(
  order: {
    id: string
    userId: string
    direction: string
    fiatAmount: any
  },
  database: Db = db
): Promise<RoundUpAccrual | null> {
  if (order.direction !== 'ON_RAMP') {
    return null
  }

  const settings = await (database as any).roundUpSettings.findUnique({
    where: { userId: order.userId },
  })

  if (!settings || !settings.enabled) {
    return null
  }

  const purchaseAmount =
    typeof order.fiatAmount === 'object' &&
    order.fiatAmount !== null &&
    'toNumber' in order.fiatAmount
      ? order.fiatAmount.toNumber()
      : Number(order.fiatAmount)

  if (purchaseAmount <= 0) {
    return null
  }

  const roundToNearest =
    typeof settings.roundToNearest === 'object' &&
    settings.roundToNearest !== null &&
    'toNumber' in settings.roundToNearest
      ? settings.roundToNearest.toNumber()
      : Number(settings.roundToNearest)

  const multiplier =
    typeof settings.multiplier === 'object' &&
    settings.multiplier !== null &&
    'toNumber' in settings.multiplier
      ? settings.multiplier.toNumber()
      : Number(settings.multiplier)

  const calc = calculateRoundUp(purchaseAmount, roundToNearest, multiplier)

  if (calc.totalRoundUp <= 0) {
    return null
  }

  const accrual = await (database as any).roundUpAccrual.create({
    data: {
      userId: order.userId,
      fiatOrderId: order.id,
      purchaseAmount: calc.purchaseAmount,
      roundUpAmount: calc.roundUpAmount,
      multiplier: calc.multiplier,
      totalRoundUp: calc.totalRoundUp,
      status: 'ACCRUED',
    },
  })

  logger.info('[RoundUp] Accrual recorded for settled on-ramp', {
    accrualId: accrual.id,
    orderId: order.id,
    userId: order.userId,
    purchaseAmount: calc.purchaseAmount,
    totalRoundUp: calc.totalRoundUp,
  })

  publishUserEvent(
    order.userId,
    EVENT_TYPE_TOPIC['round_up.accrued'],
    'round_up.accrued',
    {
      accrualId: accrual.id,
      orderId: order.id,
      purchaseAmount: calc.purchaseAmount,
      roundUpAmount: calc.roundUpAmount,
      multiplier: calc.multiplier,
      totalRoundUp: calc.totalRoundUp,
      userId: order.userId,
    }
  ).catch(() => {})

  return accrual
}

/**
 * Returns current accumulated unswept balance and accrual history for a user.
 *
 * @param userId - Unique user identifier.
 * @param database - Database client instance.
 * @returns Summary of unswept balance and detailed accrual list.
 */
export async function getRoundUpAccruals(
  userId: string,
  database: Db = db
): Promise<RoundUpAccrualsResponse> {
  const accruals = await (database as any).roundUpAccrual.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  })

  const unswept = accruals.filter((a: any) => a.status === 'ACCRUED')
  const unsweptBalance = unswept.reduce((sum: number, a: any) => {
    const val =
      typeof a.totalRoundUp === 'object' &&
      a.totalRoundUp !== null &&
      'toNumber' in a.totalRoundUp
        ? a.totalRoundUp.toNumber()
        : Number(a.totalRoundUp)
    return sum + val
  }, 0)

  return {
    unsweptBalance: Math.round(unsweptBalance * 100) / 100,
    currency: 'USD',
    unsweptCount: unswept.length,
    accruals,
  }
}
