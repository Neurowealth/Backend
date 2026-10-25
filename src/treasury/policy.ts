/**
 * Versioned, validated treasury sweep policies (#528).
 *
 * A policy governs one tier pair (e.g. HOT->WARM). Writes are never
 * mutations: createPolicyVersion deactivates the current active policy for
 * that pair and inserts a new row in the same transaction, so a policy
 * change is always an auditable new version, not a silent overwrite.
 */
import { Prisma, TreasuryTier } from '@prisma/client'
import db from '../db'
import { logger } from '../utils/logger'

type Db = typeof db | Prisma.TransactionClient

export class TreasuryPolicyValidationError extends Error {}

export interface PolicyInput {
  fromTier: TreasuryTier
  toTier: TreasuryTier
  maxHotBalance: string
  sweepIntervalMinutes: number
  minSweepAmount: string
  requiresApprovalAbove?: string | null
}

export function validatePolicyInput(input: PolicyInput): void {
  if (input.fromTier === input.toTier) {
    throw new TreasuryPolicyValidationError('fromTier and toTier must differ')
  }
  if (input.sweepIntervalMinutes <= 0) {
    throw new TreasuryPolicyValidationError(
      'sweepIntervalMinutes must be positive'
    )
  }

  const max = Number(input.maxHotBalance)
  const min = Number(input.minSweepAmount)

  if (!(max > 0)) {
    throw new TreasuryPolicyValidationError('maxHotBalance must be positive')
  }
  if (!(min > 0) || min >= max) {
    throw new TreasuryPolicyValidationError(
      'minSweepAmount must be positive and less than maxHotBalance'
    )
  }
  if (input.requiresApprovalAbove != null) {
    const threshold = Number(input.requiresApprovalAbove)
    if (threshold > max) {
      throw new TreasuryPolicyValidationError(
        'requiresApprovalAbove cannot exceed maxHotBalance'
      )
    }
  }
}

export interface TreasurySweepPolicyRecord {
  id: string
  fromTier: TreasuryTier
  toTier: TreasuryTier
  maxHotBalance: Prisma.Decimal
  sweepIntervalMinutes: number
  minSweepAmount: Prisma.Decimal
  requiresApprovalAbove: Prisma.Decimal | null
  version: number
  isActive: boolean
  sweepsEnabled: boolean
}

export async function createPolicyVersion(
  input: PolicyInput,
  createdBy: string,
  database: Db = db
): Promise<TreasurySweepPolicyRecord> {
  validatePolicyInput(input)

  return (database as typeof db).$transaction(async (tx) => {
    const current = await tx.treasurySweepPolicy.findFirst({
      where: { fromTier: input.fromTier, toTier: input.toTier, isActive: true },
      orderBy: { version: 'desc' },
    })

    if (current) {
      await tx.treasurySweepPolicy.update({
        where: { id: current.id },
        data: { isActive: false },
      })
    }

    const created = await tx.treasurySweepPolicy.create({
      data: {
        fromTier: input.fromTier,
        toTier: input.toTier,
        maxHotBalance: input.maxHotBalance,
        sweepIntervalMinutes: input.sweepIntervalMinutes,
        minSweepAmount: input.minSweepAmount,
        requiresApprovalAbove: input.requiresApprovalAbove ?? null,
        version: (current?.version ?? 0) + 1,
        isActive: true,
        createdBy,
      },
    })

    logger.info('[TreasuryPolicy] New policy version created', {
      fromTier: input.fromTier,
      toTier: input.toTier,
      version: created.version,
      createdBy,
    })

    return created
  })
}

export async function getActivePolicy(
  fromTier: TreasuryTier,
  toTier: TreasuryTier,
  database: Db = db
): Promise<TreasurySweepPolicyRecord | null> {
  return (database as typeof db).treasurySweepPolicy.findFirst({
    where: { fromTier, toTier, isActive: true },
  })
}

export const SWEEP_CONFIRMATION = 'SWEEP'

/**
 * Enables sweeps for a policy (#620). New policy versions start disabled; an
 * operator must preview the sweep and type SWEEP to turn the policy on.
 */
export async function enablePolicy(
  policyId: string,
  confirmation: string,
  enabledBy: string,
  database: Db = db
): Promise<TreasurySweepPolicyRecord> {
  if (confirmation !== SWEEP_CONFIRMATION) {
    throw new TreasuryPolicyValidationError(
      `confirmation must be the exact text ${SWEEP_CONFIRMATION}`
    )
  }
  const policy = await database.treasurySweepPolicy.findUnique({
    where: { id: policyId },
  })
  if (!policy) {
    throw new TreasuryPolicyValidationError('policy not found')
  }
  if (!policy.isActive) {
    throw new TreasuryPolicyValidationError(
      'only the active policy version can be enabled'
    )
  }
  const updated = await database.treasurySweepPolicy.update({
    where: { id: policyId },
    data: { sweepsEnabled: true, enabledBy, enabledAt: new Date() },
  })
  logger.info('[TreasuryPolicy] Sweeps enabled', { policyId, enabledBy })
  return updated
}
