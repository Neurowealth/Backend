import db from '../db'
import { logger } from '../utils/logger'
import {
  createAlertRuleSchema,
  type DeliveryChannel,
} from '../validators/alert-validators'

/**
 * WhatsApp-facing alert-rule management (#289).
 *
 * The WhatsApp layer identifies users by wallet address (the in-memory phone
 * store holds the custodial wallet), so these helpers resolve the DB user by
 * walletAddress and then perform the same owner-scoped CRUD the HTTP routes do.
 * A rule is only ever visible or mutable by its owner — the walletAddress →
 * userId resolution IS the ownership check here.
 */

export interface AlertRuleView {
  id: string
  metric: string
  protocolName: string | null
  comparator: string
  threshold: number
  deliveryChannel: string
  cooldownMinutes: number
  isActive: boolean
}

const viewSelect = {
  id: true,
  metric: true,
  protocolName: true,
  comparator: true,
  threshold: true,
  deliveryChannel: true,
  cooldownMinutes: true,
  isActive: true,
}

function toView(rule: {
  id: string
  metric: string
  protocolName: string | null
  comparator: string
  threshold: unknown
  deliveryChannel: string
  cooldownMinutes: number
  isActive: boolean
}): AlertRuleView {
  return {
    id: rule.id,
    metric: rule.metric,
    protocolName: rule.protocolName,
    comparator: rule.comparator,
    threshold: Number(rule.threshold),
    deliveryChannel: rule.deliveryChannel,
    cooldownMinutes: rule.cooldownMinutes,
    isActive: rule.isActive,
  }
}

async function resolveUserId(walletAddress: string): Promise<string | null> {
  const user = await db.user.findUnique({
    where: { walletAddress },
    select: { id: true },
  })
  return user?.id ?? null
}

export type CreateAlertResult =
  | { ok: true; rule: AlertRuleView }
  | { ok: false; error: string }

/**
 * Create an alert rule for the user owning `walletAddress`. Validates the
 * (partially NLP-derived) input through the same Zod schema the HTTP route
 * uses, so conversational and API rules share one validation source of truth.
 */
export async function createAlertRuleForWallet(
  walletAddress: string,
  input: {
    metric?: string
    protocolName?: string
    comparator?: string
    threshold?: number
    deliveryChannel: DeliveryChannel
  },
): Promise<CreateAlertResult> {
  const userId = await resolveUserId(walletAddress)
  if (!userId) {
    return { ok: false, error: 'I could not find your account. Please try again.' }
  }

  const parsed = createAlertRuleSchema.safeParse({
    metric: input.metric,
    protocolName: input.protocolName,
    comparator: input.comparator,
    threshold: input.threshold,
    deliveryChannel: input.deliveryChannel,
  })

  if (!parsed.success) {
    // Surface a single friendly hint rather than raw Zod detail over WhatsApp.
    return {
      ok: false,
      error:
        'I couldn\'t understand that alert. Try e.g. "alert me when Blend apy below 5" or "notify me if portfolio value below 1000".',
    }
  }

  const rule = await db.alertRule.create({
    data: {
      userId,
      metric: parsed.data.metric,
      protocolName: parsed.data.protocolName ?? null,
      comparator: parsed.data.comparator,
      threshold: parsed.data.threshold,
      deliveryChannel: parsed.data.deliveryChannel,
      cooldownMinutes: parsed.data.cooldownMinutes,
    },
    select: viewSelect,
  })

  return { ok: true, rule: toView(rule) }
}

/** List the alert rules owned by the user behind `walletAddress`. */
export async function listAlertRulesForWallet(
  walletAddress: string,
): Promise<AlertRuleView[]> {
  const userId = await resolveUserId(walletAddress)
  if (!userId) return []

  const rules = await db.alertRule.findMany({
    where: { userId },
    select: viewSelect,
    orderBy: { createdAt: 'desc' },
  })
  return rules.map(toView)
}

/**
 * Delete an alert rule by id, but only if it belongs to `walletAddress`.
 * Returns true when a rule was deleted, false when none matched (unknown id or
 * not owned by this user) — the caller cannot distinguish the two, by design.
 */
export async function deleteAlertRuleForWallet(
  walletAddress: string,
  alertId: string,
): Promise<boolean> {
  const userId = await resolveUserId(walletAddress)
  if (!userId) return false

  const result = await db.alertRule.deleteMany({
    where: { id: alertId, userId },
  })

  if (result.count > 0) {
    logger.info(`[AlertManager] Deleted alert ${alertId} for user ${userId}`)
  }
  return result.count > 0
}
