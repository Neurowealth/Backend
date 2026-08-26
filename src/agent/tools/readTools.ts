/**
 * Read-only assistant tools (#318).
 *
 * Every tool here returns the same allowlist-mapped shape the REST routes
 * return (src/utils/api-formatters.ts) — never a raw DB row. This is what
 * "no fabricated numbers" rests on downstream: the model is only ever shown
 * numbers that came out of one of these calls, never something it recalls
 * from earlier in the transcript.
 */

import { z } from 'zod'
import db from '../../db'
import { defineTool } from './types'
import {
  mapPositionToResponse,
  mapTransactionToResponse,
} from '../../utils/api-formatters'
import { scanAllProtocols } from '../scanner'
import { getGoalForUser, computeGoalProgress } from '../../goals/service'
import { getActiveFollow } from '../../strategy/service'

const emptyArgs = z.object({}).strict()

export const portfolioValueTool = defineTool({
  name: 'portfolio_value',
  description:
    "Get the caller's current total portfolio value, total yield earned, and active position count.",
  argsSchema: emptyArgs,
  isReadOnly: true,
  requiresConfirmation: false,
  subAccountPermission: 'VIEW' as const,
  summarize: () => 'View portfolio value',
  execute: async (_args, ctx) => {
    const positions = await db.position.findMany({
      where: { userId: ctx.userId },
    })
    const totalBalance = positions.reduce(
      (sum: number, p: any) => sum + Number(p.currentValue),
      0
    )
    const totalEarnings = positions.reduce(
      (sum: number, p: any) => sum + Number(p.yieldEarned),
      0
    )
    const activePositions = positions.filter(
      (p: any) => p.status === 'ACTIVE'
    ).length
    return {
      ok: true,
      data: { totalBalance, totalEarnings, activePositions },
    }
  },
})

export const positionsTool = defineTool({
  name: 'positions',
  description:
    "List the caller's current positions (protocol, asset, value, yield earned, status).",
  argsSchema: emptyArgs,
  isReadOnly: true,
  requiresConfirmation: false,
  subAccountPermission: 'VIEW' as const,
  summarize: () => 'View positions',
  execute: async (_args, ctx) => {
    const positions = await db.position.findMany({
      where: { userId: ctx.userId },
    })
    return {
      ok: true,
      data: { positions: positions.map(mapPositionToResponse) },
    }
  },
})

export const transactionsTool = defineTool({
  name: 'transactions',
  description:
    "List the caller's most recent transactions (deposits, withdrawals, rebalances).",
  argsSchema: z
    .object({
      limit: z.number().int().min(1).max(50).default(10).optional(),
    })
    .strict(),
  isReadOnly: true,
  requiresConfirmation: false,
  subAccountPermission: 'VIEW' as const,
  summarize: () => 'View recent transactions',
  execute: async (args, ctx) => {
    const limit = args.limit ?? 10
    const transactions = await db.transaction.findMany({
      where: { userId: ctx.userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })
    return {
      ok: true,
      data: { transactions: transactions.map(mapTransactionToResponse) },
    }
  },
})

export const protocolRatesTool = defineTool({
  name: 'protocol_rates',
  description:
    'List currently tracked DeFi protocols and their live supply APY, from the latest on-chain scan.',
  argsSchema: emptyArgs,
  isReadOnly: true,
  requiresConfirmation: false,
  subAccountPermission: 'VIEW' as const,
  summarize: () => 'View protocol rates',
  execute: async () => {
    const protocols = await scanAllProtocols()
    return {
      ok: true,
      data: {
        protocols: protocols.map((p) => ({
          name: p.name,
          apy: p.apy,
          assetSymbol: (p as any).assetSymbol,
        })),
      },
    }
  },
})

export const goalStatusTool = defineTool({
  name: 'goal_status',
  description:
    "Get the caller's active savings goal progress (target, current trajectory, on-track status), if any.",
  argsSchema: emptyArgs,
  isReadOnly: true,
  requiresConfirmation: false,
  subAccountPermission: 'VIEW' as const,
  summarize: () => 'View goal status',
  execute: async (_args, ctx) => {
    const goal = await getGoalForUser(ctx.userId)
    if (!goal) {
      return { ok: true, data: { goal: null } }
    }
    const progress = await computeGoalProgress(goal.id)
    return { ok: true, data: { goal: progress } }
  },
})

export const followedStrategyTool = defineTool({
  name: 'followed_strategy',
  description:
    "Get the strategy the caller's agent is currently following from the marketplace, if any (config snapshot only — never the publisher's identity).",
  argsSchema: emptyArgs,
  isReadOnly: true,
  requiresConfirmation: false,
  subAccountPermission: 'VIEW' as const,
  summarize: () => 'View followed strategy',
  execute: async (_args, ctx) => {
    const follow = await getActiveFollow(ctx.userId)
    return { ok: true, data: { follow: follow ?? null } }
  },
})

export const READ_TOOLS = [
  portfolioValueTool,
  positionsTool,
  transactionsTool,
  protocolRatesTool,
  goalStatusTool,
  followedStrategyTool,
] as const
