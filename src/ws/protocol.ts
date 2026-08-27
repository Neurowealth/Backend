/**
 * Client → server message schemas for the real-time stream (#316).
 *
 * The receive side of this socket is a tiny control channel — subscribe,
 * resume, ping — and nothing else. Trading and any other state-changing
 * operation stays on the authenticated REST surface where it already has
 * validation, rate limiting, idempotency, and an audit trail; a second, weaker
 * path to move money is not a feature. `.strict()` on every schema means an
 * unknown key is a 'bad_request' error frame rather than something quietly
 * ignored, so a client using a message this server does not implement finds out
 * immediately.
 */

import { z } from 'zod'
import { USER_EVENT_TOPICS } from '../events/types'

const topicSchema = z.enum(USER_EVENT_TOPICS)

const topicsSchema = z
  .array(topicSchema)
  .min(1, 'At least one topic is required')
  .max(USER_EVENT_TOPICS.length)

export const subscribeMessageSchema = z
  .object({
    type: z.literal('subscribe'),
    topics: topicsSchema,
    /**
     * Opt-in event coalescing (see docs/WEBSOCKET_STREAMING.md). Off by
     * default because it trades exact per-seq delivery for burst tolerance,
     * and that is the client's call to make, not the server's.
     */
    coalesce: z.boolean().optional(),
  })
  .strict()

export const resumeMessageSchema = z
  .object({
    type: z.literal('resume'),
    topics: topicsSchema,
    /** Last seq the client durably processed. 0 means "everything retained". */
    afterSeq: z.number().int().min(0),
    coalesce: z.boolean().optional(),
  })
  .strict()

export const unsubscribeMessageSchema = z
  .object({
    type: z.literal('unsubscribe'),
    topics: topicsSchema,
  })
  .strict()

/** Application-level keepalive, for clients that cannot observe protocol pongs. */
export const pingMessageSchema = z
  .object({
    type: z.literal('ping'),
  })
  .strict()

export const clientMessageSchema = z.discriminatedUnion('type', [
  subscribeMessageSchema,
  resumeMessageSchema,
  unsubscribeMessageSchema,
  pingMessageSchema,
])

export type ClientMessage = z.infer<typeof clientMessageSchema>
