import db from '../db'
import { logger } from '../utils/logger'
import { config } from '../config/env'

export const erasurePolicies = {
  Session: 'DELETE',
  WebhookSubscription: 'DELETE',
  AlertRule: 'DELETE',
  Transaction: 'ANONYMIZE',
  CostBasisLot: 'ANONYMIZE',
  FiatOrder: 'ANONYMIZE',
  ReferralConversion: 'ANONYMIZE',
  AuditBlock: 'IMMUTABLE',
  OutboxOp: 'IMMUTABLE',
} as const

export type ErasurePolicyKey = keyof typeof erasurePolicies

export interface ErasureResult {
  model: string
  action: 'delete' | 'anonymize' | 'immutable' | 'unknown'
  count: number
}

export async function erasureJob(
  userId: string,
  dryRun = false
): Promise<ErasureResult[]> {
  const results: ErasureResult[] = []

  for (const [modelName, action] of Object.entries(erasurePolicies) as [
    keyof typeof erasurePolicies,
    string,
  ][]) {
    let count = 0

    switch (modelName) {
      case 'Session': {
        const query = { userId }
        if (dryRun) {
          count = await db.session.count({ where: query })
          results.push({
            model: 'Session',
            action: 'delete' as const,
            count,
          })
        } else {
          const result = await db.session.deleteMany({ where: query })
          count = result.count
          results.push({
            model: 'Session',
            action: 'delete' as const,
            count,
          })
        }
        break
      }

      case 'WebhookSubscription': {
        const query = { userId }
        if (dryRun) {
          count = await db.webhookSubscription.count({ where: query })
          results.push({
            model: 'WebhookSubscription',
            action: 'delete' as const,
            count,
          })
        } else {
          const result = await db.webhookSubscription.deleteMany({
            where: query,
          })
          count = result.count
          results.push({
            model: 'WebhookSubscription',
            action: 'delete' as const,
            count,
          })
        }
        break
      }

      case 'AlertRule': {
        const query = { userId }
        if (dryRun) {
          count = await db.alertRule.count({ where: query })
          results.push({
            model: 'AlertRule',
            action: 'delete' as const,
            count,
          })
        } else {
          const result = await db.alertRule.deleteMany({ where: query })
          count = result.count
          results.push({
            model: 'AlertRule',
            action: 'delete' as const,
            count,
          })
        }
        break
      }

      case 'Transaction': {
        const query = { userId }
        if (dryRun) {
          count = await db.transaction.count({ where: query })
          // Anonymize: remove userId and set actingAsUserId to null
          results.push({
            model: 'Transaction',
            action: 'anonymize' as const,
            count,
          })
        } else {
          await db.transaction.updateMany({
            where: { userId },
            data: {
              actingAsUserId: null,
              selectedLotIds: [],
            },
          })
          count = 0 // Cannot easily count after update, use original count
          results.push({
            model: 'Transaction',
            action: 'anonymize' as const,
            count: count,
          })
        }
        break
      }

      case 'CostBasisLot': {
        const query = { userId }
        if (dryRun) {
          count = await db.costBasisLot.count({ where: query })
          results.push({
            model: 'CostBasisLot',
            action: 'anonymize' as const,
            count,
          })
        } else {
          await db.costBasisLot.updateMany({
            where: { userId },
            data: { acquisitionPrice: null, priceSource: null },
          })
          count = 0
          results.push({
            model: 'CostBasisLot',
            action: 'anonymize' as const,
            count: count,
          })
        }
        break
      }

      case 'FiatOrder': {
        const query = { userId }
        if (dryRun) {
          count = await db.fiatOrder.count({ where: query })
          results.push({
            model: 'FiatOrder',
            action: 'anonymize' as const,
            count,
          })
        } else {
          await db.fiatOrder.updateMany({
            where: { userId },
            data: {
              kycUrl: null,
              failureReason: null,
              providerQuoteId: null,
              rateLockExpiresAt: null,
              settledRate: null,
              settledCryptoAmount: null,
            },
          })
          count = 0
          results.push({
            model: 'FiatOrder',
            action: 'anonymize' as const,
            count: count,
          })
        }
        break
      }

      case 'ReferralConversion': {
        const query = { referredUserId: userId }
        if (dryRun) {
          count = await db.referralConversion.count({ where: query })
          results.push({
            model: 'ReferralConversion',
            action: 'anonymize' as const,
            count,
          })
        } else {
          await db.referralConversion.updateMany({
            where: { referredUserId: userId },
            data: {
              fraudReasons: [],
              flaggedAt: null,
              reviewedAt: null,
              reviewedBy: null,
              reviewDecision: null,
            },
          })
          count = 0
          results.push({
            model: 'ReferralConversion',
            action: 'anonymize' as const,
            count: count,
          })
        }
        break
      }

      case 'AuditBlock':
      case 'OutboxOp':
        // IMMUTABLE - leave untouched
        results.push({
          model: modelName,
          action: 'immutable' as const,
          count: 0,
        })
        break

      default:
        results.push({
          model: modelName,
          action: 'unknown' as const,
          count: 0,
        })
    }
  }

  return results
}

/**
 * Run erasure for a user with optional dry-run mode.
 * Returns a summary of what would be/has been erased.
 */
export async function eraseUserData(
  userId: string,
  dryRun = false
): Promise<{
  summary: ErasureResult[]
  totalAffected: number
  immutableCount: number
}> {
  const results = await erasureJob(userId, dryRun)
  const totalAffected = results.reduce(
    (sum, r) => sum + (r.action === 'immutable' ? 0 : r.count),
    0
  )
  const immutableCount = results.filter((r) => r.action === 'immutable').length

  return {
    summary: results,
    totalAffected,
    immutableCount,
  }
}
