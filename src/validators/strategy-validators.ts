import { z } from 'zod'

/**
 * Validators for the strategy marketplace (#285).
 *
 * This is the input layer of the three-layer anonymization boundary
 * (query → mapper → input; see docs/STRATEGY_MARKETPLACE.md). The query and
 * mapper layers stop the SERVER from leaking a publisher's identity; this layer
 * stops the PUBLISHER from leaking it themselves. `label` is the only free text
 * a user can put in front of strangers, so it is the only self-doxx vector in
 * the feature.
 */

/**
 * Publishable strategies. GOAL_TRACKING is deliberately excluded: it is driven
 * by the publisher's own SavingsGoal target and date, which are personal
 * figures that mean nothing to a follower and would have to be copied to work
 * at all. Followers with their own goal already get goal precedence anyway.
 */
export const PUBLISHABLE_STRATEGIES = [
  'MAX_YIELD',
  'TARGET_ALLOCATION',
] as const

export const MARKETPLACE_WINDOWS = ['30d', '90d'] as const
export const MARKETPLACE_SORT_FIELDS = ['apy', 'sharpe'] as const

export type MarketplaceWindow = (typeof MARKETPLACE_WINDOWS)[number]
export type MarketplaceSortField = (typeof MARKETPLACE_SORT_FIELDS)[number]

export const MAX_LABEL_LENGTH = 60

/** Stellar account (G…) or contract (C…) address: prefix + 55 base32 chars. */
const STELLAR_ADDRESS_PATTERN = /[GC][A-Z2-7]{55}/

/** A 32+ char hex run — key material, tx hashes, and most secret formats. */
const LONG_HEX_PATTERN = /[0-9a-fA-F]{32,}/

/**
 * Free-text label shown to other users. Length-capped and screened for the two
 * identifiers that would deanonymize the publisher if pasted in. Rejected
 * rather than stripped: silently mangling someone's label hides that we found
 * an address in it, and a user who pasted their wallet address needs to know.
 */
export const strategyLabelSchema = z
  .string()
  .trim()
  .min(1, 'label is required')
  .max(MAX_LABEL_LENGTH, `label must be at most ${MAX_LABEL_LENGTH} characters`)
  .refine((v) => !STELLAR_ADDRESS_PATTERN.test(v), {
    message:
      'label must not contain a Stellar address — published strategies are anonymous',
  })
  .refine((v) => !LONG_HEX_PATTERN.test(v), {
    message:
      'label must not contain long hexadecimal strings — published strategies are anonymous',
  })

/**
 * The exact three keys the agent loop reads. Nothing else is copied to a
 * follower — notably `riskTolerance`, which stays personal to each user.
 */
export const publishableConfigSchema = z
  .object({
    strategyName: z.enum(PUBLISHABLE_STRATEGIES),
    targetAllocations: z
      .record(z.string().min(1).max(100), z.number().finite().min(0).max(100))
      .optional(),
    riskCeiling: z.number().int().min(0).max(100).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.strategyName === 'TARGET_ALLOCATION') {
      const entries = Object.entries(data.targetAllocations ?? {})
      if (entries.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['targetAllocations'],
          message:
            'targetAllocations is required when strategyName is TARGET_ALLOCATION',
        })
        return
      }
      // Followers inherit these weights verbatim, so a set that does not sum to
      // 100 would quietly under- or over-allocate someone else's funds.
      const total = entries.reduce((sum, [, weight]) => sum + weight, 0)
      if (Math.abs(total - 100) > 0.01) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['targetAllocations'],
          message: `targetAllocations must sum to 100 (got ${total})`,
        })
      }
    }
  })

/**
 * POST /strategies/publish
 *
 * `strategyConfig` is optional: when omitted the caller's own
 * User.rebalanceStrategy / User.strategyConfig is snapshotted instead, which is
 * the "publish what I'm actually running" path. Supplying it explicitly is the
 * only way to publish anything today, since nothing in src/ writes those User
 * columns yet.
 */
export const publishStrategySchema = z.object({
  label: strategyLabelSchema,
  strategyConfig: publishableConfigSchema.optional(),
})

/**
 * GET /strategies/marketplace
 *
 * `window` accepts 30d and 90d ONLY. src/agent/snapshotter.ts hard-deletes
 * YieldSnapshot rows past 90 days, so a longer window has no data behind it and
 * would return a 90-day figure mislabelled as something else. Rejected with a
 * 400 that names the retention limit rather than silently downgraded.
 */
export const marketplaceQuerySchema = z.object({
  sortBy: z.enum(MARKETPLACE_SORT_FIELDS).default('sharpe'),
  window: z
    .enum(MARKETPLACE_WINDOWS, {
      error:
        'window must be "30d" or "90d". Longer windows are unavailable because yield snapshots are retained for 90 days.',
    })
    .default('30d'),
  // Deliberately NOT the shared paginationSchema defaults (limit 5 / max 50):
  // those are tuned for WhatsApp transaction lists, not a leaderboard page.
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})

/**
 * Path param for follow/unfollow. This is a PublishedStrategy id, never a
 * userId — naming it `userId` would hand it to enforceUserAccess, which
 * compares req.params.userId against the caller and would 403 every follow.
 */
export const strategyIdParamSchema = z.object({
  id: z.string().uuid('Invalid strategy ID'),
})

export type PublishStrategyInput = z.infer<typeof publishStrategySchema>
export type MarketplaceQuery = z.infer<typeof marketplaceQuerySchema>
