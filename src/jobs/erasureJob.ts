import db from '../db'
import { logger } from '../utils/logger'
import { config } from '../config/env'
import { erasurePolicies, ErasurePolicyKey } from '../privacy/dataMap'
import { eraseScalarUserRefs } from '../privacy/scalarUserRefs'

export { erasurePolicies }
export type { ErasurePolicyKey }

export interface ErasureResult {
  model: string
  action: 'delete' | 'anonymize' | 'immutable' | 'unknown'
  count: number
}

const scalarModels = new Set<string>([
  'IdempotencyRecord',
  'CustodialWallet',
  'AlertAck',
  'NotificationPreferenceAuditLog',
  'WebAuthnChallenge',
  'MessageDelivery',
  'UserEvent',
  'UserEventSequence',
  'LoanLiquidationEvent',
  'PlatformBadDebt',
  'CoverageClaim',
  'UserDataAudit',
  'TicketMessage',
  'OutboxOp',
])

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
        } else {
          const result = await db.session.deleteMany({ where: query })
          count = result.count
        }
        results.push({
          model: 'Session',
          action: 'delete' as const,
          count,
        })
        break
      }

      case 'WebhookSubscription': {
        const query = { userId }
        if (dryRun) {
          count = await db.webhookSubscription.count({ where: query })
        } else {
          const result = await db.webhookSubscription.deleteMany({
            where: query,
          })
          count = result.count
        }
        results.push({
          model: 'WebhookSubscription',
          action: 'delete' as const,
          count,
        })
        break
      }

      case 'AlertRule': {
        const query = { userId }
        if (dryRun) {
          count = await db.alertRule.count({ where: query })
        } else {
          const result = await db.alertRule.deleteMany({ where: query })
          count = result.count
        }
        results.push({
          model: 'AlertRule',
          action: 'delete' as const,
          count,
        })
        break
      }

      case 'EmailIdentity': {
        const query = { userId }
        if (dryRun) {
          count = await db.emailIdentity.count({ where: query })
        } else {
          const result = await db.emailIdentity.deleteMany({ where: query })
          count = result.count
        }
        results.push({
          model: 'EmailIdentity',
          action: 'delete' as const,
          count,
        })
        break
      }

      case 'UserWebhookEndpoint': {
        const query = { userId }
        if (dryRun) {
          count = await db.userWebhookEndpoint.count({ where: query })
        } else {
          const result = await db.userWebhookEndpoint.deleteMany({
            where: query,
          })
          count = result.count
        }
        results.push({
          model: 'UserWebhookEndpoint',
          action: 'delete' as const,
          count,
        })
        break
      }

      case 'UserApiKey': {
        const query = { userId }
        if (dryRun) {
          count = await db.userApiKey.count({ where: query })
        } else {
          const result = await db.userApiKey.deleteMany({ where: query })
          count = result.count
        }
        results.push({
          model: 'UserApiKey',
          action: 'delete' as const,
          count,
        })
        break
      }

      case 'RecurringDepositPlan': {
        const query = { userId }
        if (dryRun) {
          count = await db.recurringDepositPlan.count({ where: query })
        } else {
          const result = await db.recurringDepositPlan.deleteMany({
            where: query,
          })
          count = result.count
        }
        results.push({
          model: 'RecurringDepositPlan',
          action: 'delete' as const,
          count,
        })
        break
      }

      case 'Transaction': {
        const query = { userId }
        if (dryRun) {
          count = await db.transaction.count({ where: query })
        } else {
          count = await db.transaction.count({ where: query })
          await db.transaction.updateMany({
            where: { userId },
            data: {
              actingAsUserId: null,
              selectedLotIds: [],
            },
          })
        }
        results.push({
          model: 'Transaction',
          action: 'anonymize' as const,
          count,
        })
        break
      }

      case 'CostBasisLot': {
        const query = { userId }
        if (dryRun) {
          count = await db.costBasisLot.count({ where: query })
        } else {
          count = await db.costBasisLot.count({ where: query })
          await db.costBasisLot.updateMany({
            where: { userId },
            data: { acquisitionPrice: null, priceSource: null },
          })
        }
        results.push({
          model: 'CostBasisLot',
          action: 'anonymize' as const,
          count,
        })
        break
      }

      case 'FiatOrder': {
        const query = { userId }
        if (dryRun) {
          count = await db.fiatOrder.count({ where: query })
        } else {
          count = await db.fiatOrder.count({ where: query })
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
        }
        results.push({
          model: 'FiatOrder',
          action: 'anonymize' as const,
          count,
        })
        break
      }

      case 'ReferralConversion': {
        const query = { referredUserId: userId }
        if (dryRun) {
          count = await db.referralConversion.count({ where: query })
        } else {
          count = await db.referralConversion.count({ where: query })
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
        }
        results.push({
          model: 'ReferralConversion',
          action: 'anonymize' as const,
          count,
        })
        break
      }

      case 'User': {
        if (dryRun) {
          count = await db.user.count({ where: { id: userId } })
        } else {
          count = await db.user.count({ where: { id: userId } })
          await db.user.updateMany({
            where: { id: userId },
            data: {
              email: null,
              phone: null,
            },
          })
        }
        results.push({
          model: 'User',
          action: 'anonymize' as const,
          count,
        })
        break
      }

      case 'AuditBlock':
        results.push({
          model: modelName,
          action: 'immutable' as const,
          count: 0,
        })
        break

      default:
        if (!scalarModels.has(modelName)) {
          results.push({
            model: modelName,
            action: 'unknown' as const,
            count: 0,
          })
        }
    }
  }

  if (!dryRun) {
    const counts = await db.$transaction((tx) => eraseScalarUserRefs(tx, userId))
    for (const [model, count] of Object.entries(counts)) {
      results.push({
        model,
        action:
          erasurePolicies[model as ErasurePolicyKey] === 'DELETE'
            ? 'delete'
            : 'anonymize',
        count,
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
