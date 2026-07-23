import { z } from 'zod'

/**
 * Twilio inbound WhatsApp webhook. `Body` is optional because a voice note
 * arrives with media fields and an empty/absent body (#288). `NumMedia`/
 * `MediaUrl0`/`MediaContentType0` are Twilio's media fields; we read the first
 * attachment. `.passthrough()` keeps Twilio's other fields and — crucially — we
 * add NO defaulted keys, so the object still matches the exact params Twilio
 * signed (signature validation runs on req.body after this parse).
 */
export const whatsappWebhookSchema = z
  .object({
    From: z.string().min(1, 'From is required'),
    Body: z.string().optional(),
    NumMedia: z.string().optional(),
    MediaUrl0: z.string().url().optional(),
    MediaContentType0: z.string().optional(),
  })
  .passthrough();

const WEBHOOK_EVENTS = [
  'transaction.confirmed',
  'agent.rebalanced',
  'deposit.received',
  'withdraw.completed',
  'fiat.order.settled',
  'fiat.order.failed',
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
