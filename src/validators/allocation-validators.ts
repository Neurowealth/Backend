import { z } from 'zod'
import {
  MAX_FRONTIER_POINTS,
  DEFAULT_FRONTIER_POINTS,
} from '../analytics/optimizer'
import {
  DEFAULT_LOOKBACK_DAYS,
  MIN_ALIGNED_OBSERVATIONS,
} from '../analytics/estimation'

/**
 * Zod schemas for the allocation-suggestion endpoints (#322).
 *
 * Whole-request form (`{ params, body }` / `{ params, query }`) to match
 * src/routes/portfolio.ts, where every other schema in the file is written that
 * way and validate() writes the coerced result back onto the request.
 *
 * Every numeric bound here is also a CPU bound. This is the one endpoint in the
 * API where an unbounded query parameter translates directly into event-loop
 * time, so the caps are the same constants the optimizer enforces internally
 * rather than a second, drifting set of magic numbers.
 */

const userIdParams = z.object({
  userId: z.string().uuid(),
})

/**
 * POST /portfolio/:userId/suggest-allocation
 *
 * Body is entirely optional — the default request is "suggest something for me"
 * with no tuning at all. `.strict()` so a typo'd knob (`frontierPoint`,
 * `lookback`) is a 400 rather than being silently ignored, which on this
 * endpoint would return a confidently-wrong answer computed over the wrong
 * window.
 */
export const suggestAllocationSchema = z.object({
  params: userIdParams,
  body: z
    .object({
      /**
       * Lower bound is MIN_ALIGNED_OBSERVATIONS: below it the estimator refuses
       * to characterize a covariance matrix at all, so accepting a smaller value
       * would only produce an `insufficient_universe` outcome after doing the
       * work. Upper bound is 365 — ProtocolRate is retained well past that, but
       * a year-old APY quote says little about today's rate.
       */
      lookbackDays: z.coerce
        .number()
        .int()
        .min(MIN_ALIGNED_OBSERVATIONS)
        .max(365)
        .default(DEFAULT_LOOKBACK_DAYS),
      /** Each extra point is another full solve; hard-capped by the optimizer. */
      frontierPoints: z.coerce
        .number()
        .int()
        .min(2)
        .max(MAX_FRONTIER_POINTS)
        .default(DEFAULT_FRONTIER_POINTS),
      /**
       * Skip the suggested-vs-current backtest legs. Opt-out rather than
       * opt-in: the comparison is the point of the feature for a human caller,
       * and it is the scheduled job — not a user — that wants it off.
       */
      includeBacktest: z.coerce.boolean().default(true),
    })
    .strict()
    // Spelled out rather than `.default({})`: in Zod v4 a container default is
    // typed against the OUTPUT shape, so an empty object does not typecheck
    // even though every field has its own default. Listing them keeps the
    // no-body request identical to an empty-body one.
    .default(() => ({
      lookbackDays: DEFAULT_LOOKBACK_DAYS,
      frontierPoints: DEFAULT_FRONTIER_POINTS,
      includeBacktest: true,
    })),
})

/**
 * GET /portfolio/:userId/suggestions
 *
 * Page/limit rather than cursor, matching the marketplace listing in
 * strategy-validators.ts. Capped at 50 so a wide page cannot pull a large number
 * of stored efficient frontiers into memory at once.
 */
export const listSuggestionsSchema = z.object({
  params: userIdParams,
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  }),
})

export type SuggestAllocationBody = z.infer<
  typeof suggestAllocationSchema
>['body']
export type ListSuggestionsQuery = z.infer<
  typeof listSuggestionsSchema
>['query']
