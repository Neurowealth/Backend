/**
 * Money-moving / state-changing assistant tools (#318).
 *
 * Every tool here is a thin wrapper over an EXISTING service-layer function —
 * the same one a REST route calls — so an assistant-initiated action is no
 * less validated, idempotent, or audited than one made through the API. None
 * of these functions talk to src/stellar/contract.ts directly; see
 * tests/unit/agent/tools/structural.test.ts.
 *
 * `requiresConfirmation: true` on every tool here is enforced a second time
 * by the confirmation gate (src/agent/assistant/confirmations.ts), which
 * gates on `!isReadOnly` rather than trusting this flag — this flag exists so
 * the requirement is visible at the definition site.
 */

import { z } from 'zod'
import db from '../../db'
import { defineTool } from './types'
import { logger } from '../../utils/logger'
import {
  executeDeposit,
  executeWithdraw,
} from '../../controllers/transaction-controller'
import { executeRebalanceIfNeeded, getThresholds } from '../router'
import { compareProtocols } from '../router'
import {
  resolveEffectiveConfig,
  isKnownStrategyName,
} from '../effectiveStrategy'
import {
  loadActiveFollowsForUsers,
  followStrategy,
  unfollowStrategy,
} from '../../strategy/service'
import { addCadence } from '../../utils/cadence'
import { createAlertRuleSchema } from '../../validators/alert-validators'
import { mapFollowToResponse } from '../../utils/api-formatters'

const CADENCES = ['WEEKLY', 'BIWEEKLY', 'MONTHLY'] as const
const ASSET_SYMBOLS = z.string().trim().min(1).max(20)

async function getWalletAddress(userId: string): Promise<string | null> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { walletAddress: true },
  })
  return user?.walletAddress ?? null
}

// ── deposit ──────────────────────────────────────────────────────────────

const depositArgs = z
  .object({
    amount: z.number().positive(),
    assetSymbol: ASSET_SYMBOLS.default('USDC'),
  })
  .strict()

export const depositTool = defineTool({
  name: 'deposit',
  description: "Deposit funds into the vault on the caller's behalf.",
  argsSchema: depositArgs,
  isReadOnly: false,
  requiresConfirmation: true,
  subAccountPermission: 'DEPOSIT' as const,
  summarize: (args) => `Deposit ${args.amount} ${args.assetSymbol ?? 'USDC'}`,
  execute: async (args, ctx) => {
    const walletAddress = await getWalletAddress(ctx.userId)
    if (!walletAddress)
      return { ok: false, error: 'Account is not fully set up yet.' }

    if (ctx.dryRun) {
      return {
        ok: true,
        data: {
          preview: true,
          amount: args.amount,
          assetSymbol: args.assetSymbol,
          note: 'On-chain network fees are deducted at execution time and are not reflected in this preview.',
        },
      }
    }

    const result = await executeDeposit({
      userId: ctx.userId,
      walletAddress,
      amount: args.amount,
      assetSymbol: args.assetSymbol,
      memo: 'assistant deposit',
      actingAsUserId: ctx.actingAsUserId ?? null,
    })

    if (result.status !== 'CONFIRMED' || !result.transaction) {
      return {
        ok: false,
        error: 'The deposit could not be confirmed. Please try again.',
      }
    }

    return {
      ok: true,
      data: {
        txHash: result.transaction.txHash,
        status: result.transaction.status,
        amount: Number(result.transaction.amount),
        assetSymbol: result.transaction.assetSymbol,
      },
    }
  },
})

// ── withdraw ─────────────────────────────────────────────────────────────

const withdrawArgs = z
  .object({
    amount: z.number().positive(),
    assetSymbol: ASSET_SYMBOLS.default('USDC'),
    protocolName: z.string().trim().min(1).max(100).optional(),
  })
  .strict()

export const withdrawTool = defineTool({
  name: 'withdraw',
  description: "Withdraw funds from the vault on the caller's behalf.",
  argsSchema: withdrawArgs,
  isReadOnly: false,
  requiresConfirmation: true,
  subAccountPermission: 'WITHDRAW' as const,
  summarize: (args) => `Withdraw ${args.amount} ${args.assetSymbol ?? 'USDC'}`,
  execute: async (args, ctx) => {
    const walletAddress = await getWalletAddress(ctx.userId)
    if (!walletAddress)
      return { ok: false, error: 'Account is not fully set up yet.' }

    const positions = await db.position.findMany({
      where: { userId: ctx.userId, status: 'ACTIVE' },
    })
    const availableBalance = positions.reduce(
      (sum: number, p: any) => sum + Number(p.currentValue),
      0
    )

    if (args.amount > availableBalance) {
      return {
        ok: false,
        error: `Insufficient funds: available balance is ${availableBalance}, requested ${args.amount}.`,
      }
    }

    if (ctx.dryRun) {
      return {
        ok: true,
        data: {
          preview: true,
          amount: args.amount,
          assetSymbol: args.assetSymbol,
          availableBalance,
          note: 'On-chain network fees are deducted at execution time and are not reflected in this preview.',
        },
      }
    }

    const result = await executeWithdraw({
      userId: ctx.userId,
      walletAddress,
      amount: args.amount,
      assetSymbol: args.assetSymbol,
      protocolName: args.protocolName,
      memo: 'assistant withdrawal',
      actingAsUserId: ctx.actingAsUserId ?? null,
    })

    if (result.status !== 'CONFIRMED' || !result.transaction) {
      return {
        ok: false,
        error: 'The withdrawal could not be confirmed. Please try again.',
      }
    }

    return {
      ok: true,
      data: {
        txHash: result.transaction.txHash,
        status: result.transaction.status,
        amount: Number(result.transaction.amount),
        assetSymbol: result.transaction.assetSymbol,
      },
    }
  },
})

// ── rebalance ────────────────────────────────────────────────────────────

const rebalanceArgs = z.object({}).strict()

export const rebalanceTool = defineTool({
  name: 'rebalance',
  description:
    "Check the caller's active positions against current protocol rates and move funds to a better-yielding protocol when the net improvement clears the platform's cost threshold. A no-op if nothing qualifies.",
  argsSchema: rebalanceArgs,
  isReadOnly: false,
  requiresConfirmation: true,
  subAccountPermission: 'MANAGE_STRATEGY' as const,
  summarize: () => 'Rebalance portfolio to the best available yield',
  execute: async (_args, ctx) => {
    const user = await db.user.findUnique({
      where: { id: ctx.userId },
      select: {
        rebalanceStrategy: true,
        strategyConfig: true,
        riskTolerance: true,
      },
    })
    if (!user) return { ok: false, error: 'User not found' }

    const positions = await db.position.findMany({
      where: { userId: ctx.userId, status: 'ACTIVE' },
    })
    if (positions.length === 0) {
      return {
        ok: true,
        data: { rebalanced: false, reason: 'No active positions' },
      }
    }

    const follow = (await loadActiveFollowsForUsers([ctx.userId])).get(
      ctx.userId
    )
    const own = {
      strategyName: (user.rebalanceStrategy || null) as any,
      targetAllocations:
        (user.strategyConfig as any)?.targetAllocations || undefined,
      riskCeiling: (user.strategyConfig as any)?.riskCeiling,
    }
    const effective = resolveEffectiveConfig(own, follow?.appliedConfig)

    const byProtocol = new Map<string, typeof positions>()
    for (const p of positions) {
      const arr = byProtocol.get(p.protocolName) ?? []
      arr.push(p)
      byProtocol.set(p.protocolName, arr)
    }

    const thresholds = getThresholds()
    const hasStrategyContext =
      Boolean(effective.strategyName) || Boolean(follow)
    const preferences = hasStrategyContext
      ? [
          {
            userId: ctx.userId,
            strategyName: effective.strategyName,
            targetAllocations: effective.targetAllocations,
            riskTolerance: user.riskTolerance,
            riskCeiling: effective.riskCeiling,
            followedStrategyId: follow?.followedStrategyId ?? undefined,
          },
        ]
      : undefined

    if (ctx.dryRun) {
      const previews: Array<Record<string, unknown>> = []
      for (const [protocol, positionsInProtocol] of byProtocol) {
        const totalAmount = positionsInProtocol
          .reduce(
            (sum, p) => sum + BigInt(p.currentValue.toString().split('.')[0]),
            BigInt(0)
          )
          .toString()
        const comparison = await compareProtocols(
          protocol,
          totalAmount,
          thresholds
        )
        previews.push({
          protocol,
          wouldRebalance: comparison?.shouldRebalance ?? false,
          improvement: comparison?.improvement ?? null,
          targetProtocol: comparison?.best.name ?? null,
        })
      }
      return { ok: true, data: { preview: true, previews } }
    }

    const results: Array<Record<string, unknown>> = []
    for (const [protocol, positionsInProtocol] of byProtocol) {
      const result = await executeRebalanceIfNeeded(
        protocol,
        positionsInProtocol.map((p) => ({
          id: p.id,
          amount: p.currentValue.toString(),
          userId: ctx.userId,
        })),
        thresholds,
        preferences
      )
      results.push({ protocol, rebalanced: Boolean(result), detail: result })
    }

    return {
      ok: true,
      data: { rebalanced: results.some((r) => r.rebalanced), results },
    }
  },
})

// ── create_recurring_deposit ────────────────────────────────────────────

const recurringDepositArgs = z
  .object({
    amount: z.number().positive(),
    cadence: z.enum(CADENCES),
    assetSymbol: ASSET_SYMBOLS.default('USDC'),
  })
  .strict()

export const createRecurringDepositTool = defineTool({
  name: 'create_recurring_deposit',
  description:
    'Set up an automatic recurring deposit on a weekly, biweekly, or monthly schedule.',
  argsSchema: recurringDepositArgs,
  isReadOnly: false,
  requiresConfirmation: true,
  subAccountPermission: 'DEPOSIT' as const,
  summarize: (args) =>
    `Set up a ${args.cadence.toLowerCase()} recurring deposit of ${args.amount} ${args.assetSymbol ?? 'USDC'}`,
  execute: async (args, ctx) => {
    const nextRunAt = addCadence(args.cadence, new Date())

    if (ctx.dryRun) {
      return {
        ok: true,
        data: {
          preview: true,
          amount: args.amount,
          cadence: args.cadence,
          nextRunAt: nextRunAt.toISOString(),
        },
      }
    }

    const plan = await db.recurringDepositPlan.create({
      data: {
        userId: ctx.userId,
        amount: args.amount,
        assetSymbol: args.assetSymbol,
        cadence: args.cadence,
        nextRunAt,
      },
    })

    logger.info('[Assistant] Recurring deposit created', {
      userId: ctx.userId,
      planId: plan.id,
    })

    return {
      ok: true,
      data: {
        id: plan.id,
        amount: Number(plan.amount),
        cadence: plan.cadence,
        nextRunAt: plan.nextRunAt.toISOString(),
      },
    }
  },
})

// ── create_alert_rule ────────────────────────────────────────────────────

const alertRuleArgs = z
  .object({
    metric: z.enum(['PROTOCOL_APY', 'PORTFOLIO_VALUE', 'POSITION_DRAWDOWN']),
    protocolName: z.string().trim().min(1).max(100).optional(),
    comparator: z.enum(['LT', 'LTE', 'GT', 'GTE']),
    threshold: z.number().finite(),
    deliveryChannel: z.enum(['WEBHOOK', 'WHATSAPP', 'BOTH']).default('WEBHOOK'),
    cooldownMinutes: z.number().int().min(1).max(10080).default(60),
  })
  .strict()

export const createAlertRuleTool = defineTool({
  name: 'create_alert_rule',
  description:
    'Create an alert rule that notifies the caller when a metric crosses a threshold (protocol APY, portfolio value, or position drawdown).',
  argsSchema: alertRuleArgs,
  isReadOnly: false,
  requiresConfirmation: true,
  subAccountPermission: 'MANAGE_STRATEGY' as const,
  summarize: (args) =>
    `Alert when ${args.protocolName ?? args.metric} ${args.comparator} ${args.threshold}`,
  execute: async (args, ctx) => {
    const parsed = createAlertRuleSchema.safeParse(args)
    if (!parsed.success) {
      return { ok: false, error: 'Invalid alert rule parameters.' }
    }

    if (ctx.dryRun) {
      return { ok: true, data: { preview: true, ...parsed.data } }
    }

    const rule = await db.alertRule.create({
      data: {
        userId: ctx.userId,
        metric: parsed.data.metric,
        protocolName: parsed.data.protocolName ?? null,
        comparator: parsed.data.comparator,
        threshold: parsed.data.threshold,
        deliveryChannel: parsed.data.deliveryChannel,
        cooldownMinutes: parsed.data.cooldownMinutes,
      },
    })

    return {
      ok: true,
      data: {
        id: rule.id,
        metric: rule.metric,
        protocolName: rule.protocolName,
        comparator: rule.comparator,
        threshold: Number(rule.threshold),
      },
    }
  },
})

// ── adjust_strategy ──────────────────────────────────────────────────────

const adjustStrategyArgs = z
  .object({
    strategyName: z.enum(['MAX_YIELD', 'TARGET_ALLOCATION']),
    targetAllocations: z
      .record(z.string(), z.number().min(0).max(100))
      .optional(),
    riskCeiling: z.number().min(0).max(100).optional(),
  })
  .strict()

export const adjustStrategyTool = defineTool({
  name: 'adjust_strategy',
  description:
    "Change the caller's own rebalance strategy (MAX_YIELD or TARGET_ALLOCATION), target allocations, and/or risk ceiling.",
  argsSchema: adjustStrategyArgs,
  isReadOnly: false,
  requiresConfirmation: true,
  subAccountPermission: 'MANAGE_STRATEGY' as const,
  summarize: (args) => `Switch strategy to ${args.strategyName}`,
  execute: async (args, ctx) => {
    if (!isKnownStrategyName(args.strategyName)) {
      return { ok: false, error: 'Unknown strategy name.' }
    }

    const strategyConfig = {
      strategyName: args.strategyName,
      ...(args.targetAllocations
        ? { targetAllocations: args.targetAllocations }
        : {}),
      ...(args.riskCeiling !== undefined
        ? { riskCeiling: args.riskCeiling }
        : {}),
    }

    if (ctx.dryRun) {
      return { ok: true, data: { preview: true, strategyConfig } }
    }

    await db.user.update({
      where: { id: ctx.userId },
      data: {
        rebalanceStrategy: args.strategyName,
        strategyConfig: strategyConfig as any,
      },
    })

    logger.info('[Assistant] Strategy adjusted', {
      userId: ctx.userId,
      strategyName: args.strategyName,
    })

    return { ok: true, data: { strategyConfig } }
  },
})

// ── follow_strategy / unfollow_strategy ─────────────────────────────────

const strategyIdArgs = z.object({ strategyId: z.string().uuid() }).strict()

export const followStrategyTool = defineTool({
  name: 'follow_strategy',
  description:
    'Follow a published marketplace strategy — copies its configuration, never funds or keys.',
  argsSchema: strategyIdArgs,
  isReadOnly: false,
  requiresConfirmation: true,
  subAccountPermission: 'MANAGE_STRATEGY' as const,
  summarize: (args) => `Follow strategy ${args.strategyId}`,
  execute: async (args, ctx) => {
    if (ctx.dryRun) {
      const strategy = await db.publishedStrategy.findFirst({
        where: { id: args.strategyId, isPublished: true },
        select: {
          id: true,
          label: true,
          strategyConfig: true,
          configVersion: true,
        },
      })
      if (!strategy)
        return { ok: false, error: 'Published strategy not found.' }
      return { ok: true, data: { preview: true, strategy } }
    }

    try {
      const follow = await followStrategy(ctx.userId, args.strategyId)
      return { ok: true, data: mapFollowToResponse(follow) }
    } catch (err) {
      return {
        ok: false,
        error:
          err instanceof Error ? err.message : 'Could not follow strategy.',
      }
    }
  },
})

export const unfollowStrategyTool = defineTool({
  name: 'unfollow_strategy',
  description: 'Stop following the currently followed marketplace strategy.',
  argsSchema: strategyIdArgs,
  isReadOnly: false,
  requiresConfirmation: true,
  subAccountPermission: 'MANAGE_STRATEGY' as const,
  summarize: () => 'Unfollow current strategy',
  execute: async (args, ctx) => {
    if (ctx.dryRun) {
      return { ok: true, data: { preview: true, strategyId: args.strategyId } }
    }

    try {
      const result = await unfollowStrategy(ctx.userId, args.strategyId)
      return {
        ok: true,
        data: {
          id: result.id,
          unfollowedAt: result.unfollowedAt.toISOString(),
        },
      }
    } catch (err) {
      return {
        ok: false,
        error:
          err instanceof Error ? err.message : 'Could not unfollow strategy.',
      }
    }
  },
})

export const ACTION_TOOLS = [
  depositTool,
  withdrawTool,
  rebalanceTool,
  createRecurringDepositTool,
  createAlertRuleTool,
  adjustStrategyTool,
  followStrategyTool,
  unfollowStrategyTool,
] as const
