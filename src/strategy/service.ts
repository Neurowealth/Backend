/**
 * Strategy marketplace (#285) — business logic for publishing, following, and
 * ranking anonymized agent configurations.
 *
 * ─── THE CUSTODY BOUNDARY ────────────────────────────────────────────────────
 *
 * A follow copies CONFIGURATION and nothing else. This module deliberately
 * imports nothing from src/stellar/ — no wallet, no contract, no key custody —
 * so there is no code path from a follow to another user's funds. That is a
 * structural property, not a documented promise, and
 * tests/integration/agent/strategy-follow.integration.test.ts asserts the
 * import graph stays that way. Do not add a stellar import here.
 *
 * ─── THE ANONYMIZATION BOUNDARY ──────────────────────────────────────────────
 *
 * `marketplaceSelect` below is layer 1 of 3 (query → mapper → input; see
 * docs/STRATEGY_MARKETPLACE.md). It never selects `userId` and never includes
 * `user`. A publisher's id IS loaded in followStrategy — but only to compare
 * against the caller for the self-follow check, and it never reaches a
 * response. Follow the alertSelect pattern in src/routes/alerts.ts: add fields
 * to the allowlist explicitly, never spread a row.
 */

import { Prisma } from '@prisma/client'
import db from '../db'
import { logger } from '../utils/logger'
import { publishUserEvent } from '../events/publisher'
import { EVENT_TYPE_TOPIC } from '../events/types'
import { sendWhatsAppMessage } from '../utils/twilio-client'
import {
  formatStrategyUpdatedReply,
  formatStrategyUnpublishedReply,
} from '../whatsapp/formatters'
import {
  StrategyConfigShape,
  isMaterialConfigChange,
  parseStrategyConfig,
} from '../agent/effectiveStrategy'
import {
  MarketplaceSortField,
  MarketplaceWindow,
} from '../validators/strategy-validators'

type Db = typeof db | Prisma.TransactionClient

export class StrategyNotFoundError extends Error {}
export class StrategyFollowNotFoundError extends Error {}
export class StrategySelfFollowError extends Error {}
export class StrategyValidationError extends Error {}

/**
 * Fields any marketplace/following query may return about a published
 * strategy. `userId` is absent by construction, not by omission.
 */
const marketplaceSelect = {
  id: true,
  label: true,
  strategyConfig: true,
  configVersion: true,
  isPublished: true,
  publishedAt: true,
} as const

/** The publisher's own view — same fields; they already know who they are. */
const ownerSelect = {
  ...marketplaceSelect,
  createdAt: true,
  updatedAt: true,
} as const

export const WINDOW_DAYS: Record<MarketplaceWindow, number> = {
  '30d': 30,
  '90d': 90,
}

export interface PublishStrategyInput {
  label: string
  strategyConfig?: StrategyConfigShape
}

export interface MarketplaceQueryInput {
  sortBy: MarketplaceSortField
  window: MarketplaceWindow
  page: number
  limit: number
}

/**
 * The publisher's effective config: the body's `strategyConfig` when supplied,
 * otherwise a snapshot of what they are actually running (User.rebalanceStrategy
 * + User.strategyConfig).
 *
 * Only the three agent-relevant keys are ever taken. `riskTolerance` is
 * explicitly NOT copied — it is a personal preference, not part of a strategy,
 * and a follower's own tolerance must survive a follow.
 */
async function resolvePublishableConfig(
  userId: string,
  supplied: StrategyConfigShape | undefined,
  database: Db
): Promise<StrategyConfigShape> {
  if (supplied) return supplied

  const user = await (database as typeof db).user.findUnique({
    where: { id: userId },
    select: { rebalanceStrategy: true, strategyConfig: true },
  })

  if (!user) throw new StrategyNotFoundError('User not found')

  const stored = parseStrategyConfig(user.strategyConfig)
  const config: StrategyConfigShape = {
    ...stored,
    strategyName:
      stored.strategyName ??
      (parseStrategyConfig({ strategyName: user.rebalanceStrategy })
        .strategyName ||
        undefined),
  }

  if (!config.strategyName) {
    throw new StrategyValidationError(
      'No strategy to publish — configure a rebalance strategy first or supply strategyConfig in the request body'
    )
  }

  return config
}

/**
 * Publish (or re-publish) the caller's strategy. Upsert, not insert: publish
 * always acts on the caller, so PublishedStrategy.userId is unique and a second
 * call updates the same row.
 *
 * Version bumping is the reason this is more than an upsert. `configVersion`
 * increments ONLY on a material change to the three agent-relevant keys — a
 * label edit is cosmetic and must not push a notification to every follower.
 * When it does bump, every active follower's `appliedConfig` snapshot is
 * rewritten in the SAME transaction as the bump, so a follower can never be
 * left pointing at a version that no longer describes what they run.
 * Notifications fire outside the transaction, fire-and-forget.
 */
export async function publishStrategy(
  userId: string,
  input: PublishStrategyInput
): Promise<{ strategy: any; materialChange: boolean }> {
  const config = await resolvePublishableConfig(
    userId,
    input.strategyConfig,
    db
  )
  const now = new Date()

  const existing = await db.publishedStrategy.findUnique({
    where: { userId },
    select: { id: true, strategyConfig: true, configVersion: true },
  })

  const materialChange = existing
    ? isMaterialConfigChange(
        parseStrategyConfig(existing.strategyConfig),
        config
      )
    : false

  const result = await db.$transaction(async (tx) => {
    const nextVersion = existing
      ? existing.configVersion + (materialChange ? 1 : 0)
      : 1

    const strategy = await tx.publishedStrategy.upsert({
      where: { userId },
      create: {
        userId,
        label: input.label,
        strategyConfig: config as Prisma.InputJsonValue,
        configVersion: 1,
        isPublished: true,
        publishedAt: now,
      },
      update: {
        label: input.label,
        strategyConfig: config as Prisma.InputJsonValue,
        configVersion: nextVersion,
        isPublished: true,
        // publishedAt marks the first time this strategy went live and is what
        // "listed since" shows; re-publishing after an unpublish restores it
        // only if it was never set.
        ...(existing ? {} : { publishedAt: now }),
      },
      select: ownerSelect,
    })

    if (materialChange) {
      await tx.strategyFollow.updateMany({
        where: { publishedStrategyId: strategy.id, unfollowedAt: null },
        data: {
          appliedConfig: config as Prisma.InputJsonValue,
          appliedConfigVersion: nextVersion,
          appliedAt: now,
        },
      })
    }

    return strategy
  })

  logger.info('[Strategy] Strategy published', {
    userId,
    strategyId: result.id,
    configVersion: result.configVersion,
    materialChange,
    strategyName: config.strategyName,
  })

  if (materialChange) {
    void notifyFollowers(result.id, 'strategy.updated', {
      label: result.label,
      configVersion: result.configVersion,
    })
  }

  return { strategy: result, materialChange }
}

/**
 * Unpublish the caller's strategy. Immediate: `isPublished=false` drops it from
 * every marketplace query on the next request.
 *
 * Follows are NOT severed. A follower keeps their `appliedConfig` snapshot and
 * their agent keeps working — silently reverting someone's live configuration
 * because a stranger delisted theirs would change what the agent does with the
 * follower's money without the follower ever acting.
 */
export async function unpublishStrategy(userId: string): Promise<any> {
  const existing = await db.publishedStrategy.findUnique({
    where: { userId },
    select: { id: true, isPublished: true },
  })

  if (!existing) throw new StrategyNotFoundError('Published strategy not found')

  const updated = await db.publishedStrategy.update({
    where: { userId },
    data: { isPublished: false },
    select: ownerSelect,
  })

  logger.info('[Strategy] Strategy unpublished', {
    userId,
    strategyId: updated.id,
  })

  if (existing.isPublished) {
    void notifyFollowers(updated.id, 'strategy.unpublished', {
      label: updated.label,
    })
  }

  return updated
}

/**
 * Leaderboard page.
 *
 * Rooted at PublishedStrategyMetric rather than PublishedStrategy so the sort
 * happens in SQL against the (windowDays, isEligible, sharpe|apy) index — a
 * JS-computed score cannot be ordered with skip/take, and recomputing every
 * publisher's snapshot history per request would be a DoS vector on a
 * semi-public endpoint.
 *
 * `isEligible: true` is what excludes thin track records ENTIRELY rather than
 * ranking them low. A strategy with one lucky day never appears at all.
 */
export async function getMarketplace(input: MarketplaceQueryInput): Promise<{
  page: number
  limit: number
  total: number
  window: MarketplaceWindow
  sortBy: MarketplaceSortField
  entries: any[]
}> {
  const windowDays = WINDOW_DAYS[input.window]
  const skip = (input.page - 1) * input.limit

  const where = {
    windowDays,
    isEligible: true,
    publishedStrategy: { isPublished: true },
  } as const

  const [total, rows] = await Promise.all([
    db.publishedStrategyMetric.count({ where }),
    db.publishedStrategyMetric.findMany({
      where,
      orderBy: [{ [input.sortBy]: 'desc' }, { computedAt: 'desc' }],
      skip,
      take: input.limit,
      select: {
        apy: true,
        sharpe: true,
        sampleCount: true,
        trackRecordDays: true,
        windowDays: true,
        computedAt: true,
        publishedStrategy: { select: marketplaceSelect },
      },
    }),
  ])

  // vsBenchmark (#320) is read alongside, never sorted on: PublishedStrategyMetric
  // stays the single ORDER BY/skip/take source (the DoS-prevention rationale
  // above), and this is a bounded follow-up lookup over the current page only
  // (at most `limit` ids), not a per-request recompute across every publisher.
  const strategyIds = rows.map((r) => r.publishedStrategy.id)
  const attributions =
    strategyIds.length > 0
      ? await db.strategyAttribution.findMany({
          where: { publishedStrategyId: { in: strategyIds }, windowDays },
          select: {
            publishedStrategyId: true,
            portfolioReturn: true,
            benchmarkReturn: true,
          },
        })
      : []
  const vsBenchmarkByStrategyId = new Map(
    attributions.map((a) => [
      a.publishedStrategyId,
      a.portfolioReturn - a.benchmarkReturn,
    ])
  )

  const entries = rows.map((row) => ({
    ...row,
    vsBenchmark: vsBenchmarkByStrategyId.get(row.publishedStrategy.id) ?? null,
  }))

  return {
    page: input.page,
    limit: input.limit,
    total,
    window: input.window,
    sortBy: input.sortBy,
    entries,
  }
}

/**
 * The caller's active follow, if any. Returns the follow's own `appliedConfig`
 * snapshot alongside the (possibly delisted, possibly orphaned) strategy, since
 * the snapshot — not the live strategy — is what their agent applies.
 */
export async function getActiveFollow(followerUserId: string): Promise<any> {
  return db.strategyFollow.findFirst({
    where: { followerUserId, unfollowedAt: null },
    select: {
      id: true,
      publishedStrategyId: true,
      appliedConfig: true,
      appliedConfigVersion: true,
      appliedAt: true,
      followedAt: true,
      publishedStrategy: { select: marketplaceSelect },
    },
  })
}

/**
 * Follow a published strategy.
 *
 * Following while already following someone else swaps atomically: the previous
 * follow is closed and the new one created inside one transaction, so the
 * partial unique index `strategy_follows_active_follower_key` (at most one row
 * per user with `unfollowedAt IS NULL`) is never violated. That index is the
 * structural backstop — if this transaction is ever refactored wrong, the
 * database rejects the write rather than letting a user's agent see two
 * conflicting configs.
 */
export async function followStrategy(
  followerUserId: string,
  strategyId: string
): Promise<any> {
  const strategy = await db.publishedStrategy.findFirst({
    where: { id: strategyId, isPublished: true },
    // userId is read ONLY for the self-follow comparison below and must not
    // escape this function.
    select: {
      id: true,
      userId: true,
      label: true,
      strategyConfig: true,
      configVersion: true,
    },
  })

  if (!strategy) {
    throw new StrategyNotFoundError('Published strategy not found')
  }

  if (strategy.userId === followerUserId) {
    throw new StrategySelfFollowError('You cannot follow your own strategy')
  }

  const now = new Date()

  const follow = await db.$transaction(async (tx) => {
    await tx.strategyFollow.updateMany({
      where: { followerUserId, unfollowedAt: null },
      data: { unfollowedAt: now },
    })

    return tx.strategyFollow.create({
      data: {
        followerUserId,
        publishedStrategyId: strategy.id,
        appliedConfig: strategy.strategyConfig as Prisma.InputJsonValue,
        appliedConfigVersion: strategy.configVersion,
        appliedAt: now,
      },
      select: {
        id: true,
        publishedStrategyId: true,
        appliedConfig: true,
        appliedConfigVersion: true,
        appliedAt: true,
        followedAt: true,
        publishedStrategy: { select: marketplaceSelect },
      },
    })
  })

  logger.info('[Strategy] Follow created', {
    followerUserId,
    strategyId: strategy.id,
    appliedConfigVersion: strategy.configVersion,
  })

  return follow
}

/**
 * Release the caller's active follow.
 *
 * Normally matched by strategy id. The orphan fallback exists because
 * `publishedStrategyId` goes NULL when a publisher deletes their account
 * (onDelete: SetNull) — without it the follower would have no id left to name
 * and could never release the follow. Only ever touches the caller's own single
 * active row, so the looser match is not a privilege boundary.
 */
export async function unfollowStrategy(
  followerUserId: string,
  strategyId: string
): Promise<{ id: string; unfollowedAt: Date }> {
  const active = await db.strategyFollow.findFirst({
    where: { followerUserId, unfollowedAt: null },
    select: { id: true, publishedStrategyId: true },
  })

  if (
    !active ||
    (active.publishedStrategyId !== null &&
      active.publishedStrategyId !== strategyId)
  ) {
    throw new StrategyFollowNotFoundError('Active follow not found')
  }

  const now = new Date()
  await db.strategyFollow.update({
    where: { id: active.id },
    data: { unfollowedAt: now },
  })

  logger.info('[Strategy] Follow released', {
    followerUserId,
    strategyId: active.publishedStrategyId,
    followId: active.id,
  })

  return { id: active.id, unfollowedAt: now }
}

export interface ActiveFollowConfig {
  followId: string
  followedStrategyId: string | null
  appliedConfig: StrategyConfigShape
  appliedConfigVersion: number
}

/**
 * Bulk-load active follows for the agent loop, keyed by follower userId.
 *
 * One query for the whole tick rather than one per user. Returns an empty Map
 * when no user in the batch follows anything, which is the path every user
 * without a follow takes — see the no-follow contract in
 * src/agent/effectiveStrategy.ts.
 */
export async function loadActiveFollowsForUsers(
  userIds: string[]
): Promise<Map<string, ActiveFollowConfig>> {
  const byUser = new Map<string, ActiveFollowConfig>()
  if (userIds.length === 0) return byUser

  const follows = await db.strategyFollow.findMany({
    where: { followerUserId: { in: userIds }, unfollowedAt: null },
    select: {
      id: true,
      followerUserId: true,
      publishedStrategyId: true,
      appliedConfig: true,
      appliedConfigVersion: true,
    },
  })

  for (const follow of follows) {
    byUser.set(follow.followerUserId, {
      followId: follow.id,
      followedStrategyId: follow.publishedStrategyId,
      appliedConfig: parseStrategyConfig(follow.appliedConfig),
      appliedConfigVersion: follow.appliedConfigVersion,
    })
  }

  return byUser
}

/**
 * Best-effort notification fan-out to a strategy's active followers.
 *
 * Runs OUTSIDE the transaction that changed the strategy and never rethrows:
 * a Twilio outage or a dead webhook endpoint must not roll back a publish or
 * leave a follower's snapshot half-written. Same fire-and-forget convention as
 * publishUserEvent(...).catch(() => {}) in agent/loop.ts.
 *
 * A follower with no phone on file is warned and skipped, never thrown —
 * matching src/jobs/alertRules.ts.
 */
async function notifyFollowers(
  strategyId: string,
  event: 'strategy.updated' | 'strategy.unpublished',
  details: { label: string; configVersion?: number }
): Promise<void> {
  try {
    const followers = await db.strategyFollow.findMany({
      where: { publishedStrategyId: strategyId, unfollowedAt: null },
      select: { followerUserId: true, follower: { select: { phone: true } } },
    })

    if (followers.length === 0) return

    await Promise.allSettled(
      followers.map(async (follower) => {
        const data = {
          strategyId,
          followerUserId: follower.followerUserId,
          label: details.label,
          ...(details.configVersion !== undefined
            ? { configVersion: details.configVersion }
            : {}),
        }

        // #316: one call reaches this follower's live socket AND the operator
        // webhook channel. Still anonymised — the payload names the strategy
        // and the follower, never the publisher.
        await publishUserEvent(
          follower.followerUserId,
          EVENT_TYPE_TOPIC[event],
          event,
          data
        ).catch((error) => {
          logger.warn('[Strategy] Event publish failed', {
            event,
            strategyId,
            error: error instanceof Error ? error.message : 'Unknown error',
          })
        })

        if (!follower.follower?.phone) {
          logger.warn(
            `[Strategy] Follower ${follower.followerUserId} has no phone on file — skipping WhatsApp for ${event}`
          )
          return
        }

        const body =
          event === 'strategy.updated'
            ? formatStrategyUpdatedReply({
                label: details.label,
                configVersion: details.configVersion ?? 1,
              })
            : formatStrategyUnpublishedReply({ label: details.label })

        await sendWhatsAppMessage({
          to: `whatsapp:${follower.follower.phone}`,
          body,
        })
      })
    )
  } catch (error) {
    logger.error('[Strategy] Follower notification fan-out failed', {
      strategyId,
      event,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
  }
}
