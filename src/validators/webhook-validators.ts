import { z } from 'zod'

export const whatsappWebhookSchema = z.object({
  From: z.string().min(1, 'From is required'),
  Body: z.string().min(1, 'Body is required'),
})

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
