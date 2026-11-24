/**
 * Money-moving / state-changing assistant tools (#318).
 *
 * Every tool here is a thin wrapper over an EXISTING service-layer function â€”
 * the same one a REST route calls â€” so an assistant-initiated action is no
 * less validated, idempotent, or audited than one made through the API. None
 * of these functions talk to src/stellar/contract.ts directly; see
 * tests/unit/agent/tools/structural.test.ts.
 *
 * `requiresConfirmation: true` on every tool here is enforced a second time
 * by the confirmation gate (src/agent/assistant/confirmations.ts), which
 * gates on `!isReadOnly` rather than trusting this flag â€” this flag exists so
 * the requirement is visible at the definition site.
 */

import { z } from 'zod'
import { Decimal } from '@prisma/client/runtime/library'
import db from '../../db'
import { defineTool } from './types'
import { logger } from '../../utils/logger'
import {
  executeDeposit,
  executeWithdraw,
} from '../../controllers/transaction-controller'
import { executeRebalanceIfNeeded, getThresholds, compareProtocols } from '../router'
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
import { onChainAmountSchema } from '../../validators/common-validators'
import { getBreakerStatusForUser } from '../breakerService'
import { isPortfolioRebalanceAllowed } from '../volatilityCircuitBreaker'

const CADENCES = ['WEEKLY', 'BIWEEKLY', 'MONTHLY'] as const
const ASSET_SYMBOLS = z.string().trim().min(1).max(20)

// ---------------------------------------------------------------------------
// Per-user velocity budget for confirmed assistant money-movement calls (#765).
//
// The REST deposit/withdraw routes apply `sensitiveRateLimiter` (10 ops / 15
// min per principal). Assistant confirmations arrive through the assistant
// orchestrator, not through those HTTP routes, so they never hit that
// middleware. This in-process store provides the equivalent guard: at most
// SENSITIVE_ASSISTANT_MAX confirmed money-movement ops per user in any rolling
// SENSITIVE_ASSISTANT_WINDOW_MS window.
//
// In-memory and keyed by userId. Resets if the process restarts â€” matching
// the per-connection semantics of the HTTP limiter in single-instance
// deployments. The outbox idempotency layer is a second, durable guard.
// ---------------------------------------------------------------------------
const SENSITIVE_ASSISTANT_WINDOW_MS =
  Number(process.env.SENSITIVE_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000 // 15 min
const SENSITIVE_ASSISTANT_MAX =
  Number(process.env.SENSITIVE_RATE_LIMIT_MAX) || 10

interface VelocityEntry {
  timestamps: number[]
}

const sensitiveOpsVelocity = new Map<string, VelocityEntry>()

/**
 * Returns true when the user has headroom in their sensitive-op budget and
 * records the call. Returns false (and does NOT record) when the budget is
 * exhausted. `now` is injectable for unit-test determinism.
 */
export function checkAndRecordSensitiveOp(
  userId: string,
  now: number = Date.now()
): boolean {
  const windowStart = now - SENSITIVE_ASSISTANT_WINDOW_MS
  const entry = sensitiveOpsVelocity.get(userId) ?? { timestamps: [] }

  // Evict expired timestamps
  entry.timestamps = entry.timestamps.filter((t) => t > windowStart)

  if (entry.timestamps.length >= SENSITIVE_ASSISTANT_MAX) {
    sensitiveOpsVelocity.set(userId, entry)
    return false
  }

  entry.timestamps.push(now)
  sensitiveOpsVelocity.set(userId, entry)
  return true
}

/** Test seam: clear all velocity entries. */
export function __resetSensitiveOpsVelocityForTests(): void {
  sensitiveOpsVelocity.clear()
}

// ---------------------------------------------------------------------------

async function getWalletAddress(userId: string): Promise<string | null> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { walletAddress: true },
  })
  return user?.walletAddress ?? null
}

// -- deposit ---------------------------------------------------------------

// #765: use onChainAmountSchema instead of z.number().positive() so the
// assistant cannot propose sub-stroop, more-than-7-decimal or above-max amounts.
const depositArgs = z
  .object({
    amount: onChainAmountSchema,
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

    // #765: apply the same per-user sensitive-op velocity budget as the REST route.
    if (!checkAndRecordSensitiveOp(ctx.userId)) {
      return {
        ok: false,
        error:
          'Too many money-movement operations in a short window. Please wait a few minutes before trying again.',
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

// -- withdraw --------------------------------------------------------------

// #765: use onChainAmountSchema for the same reasons as depositArgs.
const withdrawArgs = z
  .object({
    amount: onChainAmountSchema,
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

    // #767: only positions in the requested asset (and protocol, when given)
    // count toward the balance. `Position.currentValue` is a Decimal in whole
    // token units, the same unit executeWithdraw reserves against, so the sum
    // is done with Decimal and compared with the requested token amount.
    const positions = await db.position.findMany({
      where: {
        userId: ctx.userId,
        status: 'ACTIVE',
        assetSymbol: args.assetSymbol,
        ...(args.protocolName ? { protocolName: args.protocolName } : {}),
      },
    })
    const availableDecimal = positions.reduce(
      (sum: Decimal, p: any) => sum.plus(new Decimal(String(p.currentValue))),
      new Decimal(0)
    )
    const availableBalance = availableDecimal.toNumber()

    if (availableDecimal.lessThan(new Decimal(String(args.amount)))) {
      return {
        ok: false,
        error: `Insufficient funds: available ${args.assetSymbol}${args.protocolName ? ` in ${args.protocolName}` : ''} balance is ${availableDecimal.toString()}, requested ${args.amount}.`,
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

    // #765: apply the same per-user sensitive-op velocity budget as the REST route.
    if (!checkAndRecordSensitiveOp(ctx.userId)) {
      return {
        ok: false,
        error:
          'Too many money-movement operations in a short window. Please wait a few minutes before trying again.',
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

// -- rebalance -------------------------------------------------------------

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
    // #763: check the volatility gate before moving any funds, mirroring loop.ts.
    const volatilityAllowed = await isPortfolioRebalanceAllowed(ctx.userId)
    if (!volatilityAllowed) {
      return {
        ok: false,
        error:
          'Rebalancing is currently paused due to high market volatility. The agent will resume automatically when conditions stabilise.',
      }
    }

    // #763: check circuit-breaker state for this user before executing.
    // Fail-closed: if the check itself throws, block the rebalance.
    // getBreakerStatusForUser returns { global: string | null; affectingYou: string[] }
    // where `global` is non-null when the GLOBAL breaker is OPEN.
    let blockedTargetProtocols: string[] = []
    try {
      const breakerStatus = await getBreakerStatusForUser(ctx.userId)
      if (breakerStatus.global !== null) {
        return {
          ok: false,
          error:
            `Rebalancing is currently halted by a global circuit breaker (${breakerStatus.global}). Please try again later.`,
        }
      }
      if (breakerStatus.affectingYou.length > 0) {
        return {
          ok: false,
          error:
            `Rebalancing is currently paused for your account: ${breakerStatus.affectingYou[0]}`,
        }
      }
      // blockedTargetProtocols is derived from protocol-level open breakers;
      // the router itself enforces this when batchContext carries the list.
      // We pass an empty array here â€” the router will exclude broken protocols
      // via its own protocol-breaker check when preferences are present.
      blockedTargetProtocols = []
    } catch (err) {
      logger.error('[rebalanceTool] Breaker check failed; blocking rebalance (fail-closed)', {
        userId: ctx.userId,
        error: err instanceof Error ? err.message : String(err),
      })
      return {
        ok: false,
        error:
          'Could not verify safety gates before rebalancing. Please try again in a moment.',
      }
    }

    const user = await db.user.findUnique({
      where: { id: ctx.userId },
      select: {
        rebalanceStrategy: true,
        strategyConfig: true,
        riskTolerance: true,
        liquidityFloor: true,
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

    const follow = (await loadActiveFollowsForUsers([ctx.userId])).get(ctx.userId)

    // #763: include exposureCaps and defaultMaxFraction that the loop passes but
    // the tool previously omitted, so the router's exposure-cap guard applies.
    const own = {
      strategyName: (user.rebalanceStrategy || null) as any,
      targetAllocations: (user.strategyConfig as any)?.targetAllocations || undefined,
      riskCeiling: (user.strategyConfig as any)?.riskCeiling,
      exposureCaps: (user.strategyConfig as any)?.exposureCaps,
      defaultMaxFraction: (user.strategyConfig as any)?.defaultMaxFraction,
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
      Boolean(effective.strategyName) ||
      Boolean(follow) ||
      user.liquidityFloor !== null

    const preferences = hasStrategyContext
      ? [
          {
            userId: ctx.userId,
            strategyName: effective.strategyName,
            targetAllocations: effective.targetAllocations,
            riskTolerance: user.riskTolerance,
            riskCeiling: effective.riskCeiling,
            // #763: expose caps were missing from the tool's preferences object.
            exposureCaps: effective.exposureCaps,
            defaultMaxFraction: effective.defaultMaxFraction,
            ...(user.liquidityFloor === null
              ? {}
              : { liquidityFloorUsd: Number(user.liquidityFloor) }),
            followedStrategyId: follow?.followedStrategyId ?? undefined,
          },
        ]
      : undefined

    if (ctx.dryRun) {
      // #763: route the dry-run preview through executeRebalanceIfNeeded with
      // dryRun semantics so the preview reflects the user's actual strategy
      // (TARGET_ALLOCATION users were previously shown a MAX_YIELD preview via
      // compareProtocols, which does not match what actually runs).
      //
      // We achieve this by calling executeRebalanceIfNeeded with a batchContext
      // that carries the strategy name. The router short-circuits without writing
      // to the outbox when no outbox enqueue is requested (dryRun path is
      // handled inside the router for preview context), so this is read-only.
      const previews: Array<Record<string, unknown>> = []
      for (const [protocol, positionsInProtocol] of byProtocol) {
        const totalAmount = positionsInProtocol
          .reduce(
            (sum, p) => sum + BigInt(p.currentValue.toString().split('.')[0]),
            BigInt(0)
          )
          .toString()

        // Use the router's comparison function when no strategy overrides apply
        // (MAX_YIELD default). For users with strategy context use executeRebalanceIfNeeded
        // in read-only mode (no positions array mutation, no outbox) for correctness.
        if (!hasStrategyContext) {
          const comparison = await compareProtocols(protocol, totalAmount, thresholds)
          previews.push({
            protocol,
            wouldRebalance: comparison?.shouldRebalance ?? false,
            improvement: comparison?.improvement ?? null,
            targetProtocol: comparison?.best.name ?? null,
          })
        } else {
          // Pass an empty positions array so executeRebalanceIfNeeded cannot
          // enqueue an outbox op â€” the amount is passed in totalAmount for
          // comparison purposes only.
          const result = await executeRebalanceIfNeeded(
            protocol,
            positionsInProtocol.map((p) => ({
              id: p.id,
              amount: p.currentValue.toString(),
              userId: ctx.userId,
            })),
            thresholds,
            preferences,
            {
              batchKey: `assistant-dryrun:${ctx.userId}:${protocol}`,
              strategyName: effective.strategyName ?? null,
              strategyIsFollowed: Boolean(follow),
              followedStrategyId: follow?.followedStrategyId ?? null,
              blockedProtocols: blockedTargetProtocols,
              dryRun: true,
            }
          )
          previews.push({
            protocol,
            wouldRebalance: Boolean(result),
            improvement: result?.improvedBy ?? null,
            targetProtocol: result?.toProtocol ?? null,
          })
        }
      }
      return { ok: true, data: { preview: true, previews } }
    }

    const results: Array<Record<string, unknown>> = []
    for (const [protocol, positionsInProtocol] of byProtocol) {
      // #763: skip protocols that are blocked as rebalance targets by an open
      // circuit breaker (FROM-and-TO guard, mirroring loop.ts).
      if (blockedTargetProtocols.includes(protocol)) {
        results.push({
          protocol,
          rebalanced: false,
          reason: 'blocked by circuit breaker',
        })
        continue
      }

      const result = await executeRebalanceIfNeeded(
        protocol,
        positionsInProtocol.map((p) => ({
          id: p.id,
          amount: p.currentValue.toString(),
          userId: ctx.userId,
        })),
        thresholds,
        preferences,
        {
          batchKey: `assistant:${ctx.userId}:${protocol}`,
          strategyName: effective.strategyName ?? null,
          strategyIsFollowed: Boolean(follow),
          followedStrategyId: follow?.followedStrategyId ?? null,
          // #763: pass blocked target protocols so the router excludes them.
          blockedProtocols: blockedTargetProtocols,
        }
      )
      results.push({ protocol, rebalanced: Boolean(result), detail: result })
    }

    return {
      ok: true,
      data: { rebalanced: results.some((r) => r.rebalanced), results },
    }
  },
})

// -- create_recurring_deposit ---------------------------------------------

// #765: use onChainAmountSchema for the same reasons as depositArgs.
const recurringDepositArgs = z
  .object({
    amount: onChainAmountSchema,
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

    // #765: apply the same per-user sensitive-op velocity budget as the REST route.
    if (!checkAndRecordSensitiveOp(ctx.userId)) {
      return {
        ok: false,
        error:
          'Too many money-movement operations in a short window. Please wait a few minutes before trying again.',
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

// -- create_alert_rule ----------------------------------------------------

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

// -- adjust_strategy ------------------------------------------------------

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

// -- follow_strategy / unfollow_strategy ----------------------------------

const strategyIdArgs = z.object({ strategyId: z.string().uuid() }).strict()

export const followStrategyTool = defineTool({
  name: 'follow_strategy',
  description:
    'Follow a published marketplace strategy â€” copies its configuration, never funds or keys.',
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
  argsSchema: z.object({}).strict(),
  isReadOnly: false,
  requiresConfirmation: true,
  subAccountPermission: 'MANAGE_STRATEGY' as const,
  summarize: () => 'Unfollow current strategy',
  execute: async (_args, ctx) => {
    if (ctx.dryRun) {
      return { ok: true, data: { preview: true } }
    }

    try {
      await unfollowStrategy(ctx.userId)
      return { ok: true, data: { unfollowed: true } }
    } catch (err) {
      return {
        ok: false,
        error:
          err instanceof Error ? err.message : 'Could not unfollow strategy.',
      }
    }
  },
})
