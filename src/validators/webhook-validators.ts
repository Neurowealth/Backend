import { z } from 'zod'

/**
 * Twilio inbound WhatsApp webhook. `Body` is optional because a voice note
 * arrives with media fields and an empty/absent body (#288). `NumMedia`/
 * `MediaUrl0`/`MediaContentType0` are Twilio's media fields; we read the first
 * attachment. `.passthrough()` keeps Twilio's other fields and — crucially — we
 * add NO defaulted keys, so the object still matches the exact params Twilio
 * signed (signature validation runs on req.body after this parse).
 *
 * A message must carry either text or media: `Body` alone being optional would
 * let an empty payload through to the signature check, so the refinement below
 * keeps rejecting content-free messages with 400.
 */
export const whatsappWebhookSchema = z
  .object({
    From: z.string().min(1, 'From is required'),
    Body: z.string().optional(),
    NumMedia: z.string().optional(),
    MediaUrl0: z.string().url().optional(),
    MediaContentType0: z.string().optional(),
  })
  .passthrough()
  .refine((data) => Boolean(data.Body?.trim()) || Boolean(data.MediaUrl0), {
    message: 'Either Body or media (MediaUrl0) is required',
    path: ['Body'],
  })

const WEBHOOK_EVENTS = [
  'transaction.confirmed',
  'agent.rebalanced',
  'deposit.received',
  'withdraw.completed',
  'fiat.order.settled',
  'fiat.order.failed',
  'fiat.order.rate_mismatch',
  'recurring_deposit.executed',
  'recurring_deposit.failed',
  'alert_rule.triggered',
  // Strategy marketplace (#285). Dispatched once per active follower, so the
  // payload carries `followerUserId` — a subscriber needs to know whose agent
  // is affected. Never carries the publisher's identity.
  'strategy.updated',
  'strategy.unpublished',
  // Durable outbox (#325): a money-moving op exhausted its retries and moved
  // to the terminal FAILED state — see docs/OUTBOX.md.
  'outbox.op_failed',
  // Approval workflows (#314): lifecycle of a PENDING_APPROVAL high-value
  // operation gated by an ApprovalPolicy — see docs/APPROVALS.md.
  'approval.requested',
  'approval.approved',
  'approval.rejected',
  'approval.executed',
  'approval.expired',
  'approval.cancelled',
] as const

export const createWebhookSchema = z.object({
  url: z.string().url('Must be a valid URL'),
  events: z
    .array(z.enum(WEBHOOK_EVENTS))
    .min(1, 'At least one event is required'),
})

export const updateWebhookSchema = z.object({
  url: z.string().url('Must be a valid URL').optional(),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).optional(),
  isActive: z.boolean().optional(),
})

export const webhookIdParamSchema = z.object({
  id: z.string().uuid('Invalid webhook ID'),
})

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number]
