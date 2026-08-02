import { Router, Request, Response } from 'express'
import db from '../db'
import { requireAuth } from '../middleware/authenticate'
import { validate } from '../middleware/validate'
import { sendNotFound } from '../utils/errors'
import { generateWebhookSecret } from '../utils/webhookSignature'
import {
  createWebhookSchema,
  updateWebhookSchema,
  webhookIdParamSchema,
} from '../validators/webhook-validators'

const router = Router()

// All webhook routes require auth
router.use(requireAuth)

/**
 * POST /api/webhooks
 * Create a new webhook subscription. Returns the signing secret once.
 */
router.post(
  '/',
  validate({ body: createWebhookSchema }),
  async (req: Request, res: Response) => {
    const userId = req.auth!.userId
    const { url, events } = req.body as { url: string; events: string[] }
    const secret = generateWebhookSecret()

    const subscription = await (db as any).webhookSubscription.create({
      data: { userId, url, events, secret },
      select: {
        id: true,
        url: true,
        events: true,
        isActive: true,
        createdAt: true,
      },
    })

    // Secret is returned only once, at creation time
    return res.status(201).json({ ...subscription, secret })
  }
)

/**
 * GET /api/webhooks
 * List all webhook subscriptions for the authenticated user.
 */
router.get('/', async (req: Request, res: Response) => {
  const userId = req.auth!.userId

  const subscriptions = await (db as any).webhookSubscription.findMany({
    where: { userId },
    select: {
      id: true,
      url: true,
      events: true,
      isActive: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: { createdAt: 'desc' },
  })

  return res.status(200).json({ subscriptions })
})

/**
 * GET /api/webhooks/:id
 * Get a single webhook subscription.
 */
router.get(
  '/:id',
  validate({ params: webhookIdParamSchema }),
  async (req: Request, res: Response) => {
    const userId = req.auth!.userId
    const sub = await (db as any).webhookSubscription.findFirst({
      where: { id: req.params.id, userId },
      select: {
        id: true,
        url: true,
        events: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    if (!sub) return sendNotFound(res, 'Webhook subscription')
    return res.status(200).json(sub)
  }
)

/**
 * PATCH /api/webhooks/:id
 * Update URL, events, or active status.
 */
router.patch(
  '/:id',
  validate({ params: webhookIdParamSchema, body: updateWebhookSchema }),
  async (req: Request, res: Response) => {
    const userId = req.auth!.userId

    const existing = await (db as any).webhookSubscription.findFirst({
      where: { id: req.params.id, userId },
      select: { id: true },
    })
    if (!existing) return sendNotFound(res, 'Webhook subscription')

    const updated = await (db as any).webhookSubscription.update({
      where: { id: req.params.id },
      data: req.body,
      select: {
        id: true,
        url: true,
        events: true,
        isActive: true,
        updatedAt: true,
      },
    })

    return res.status(200).json(updated)
  }
)

/**
 * DELETE /api/webhooks/:id
 * Delete a webhook subscription (and its delivery history via cascade).
 */
router.delete(
  '/:id',
  validate({ params: webhookIdParamSchema }),
  async (req: Request, res: Response) => {
    const userId = req.auth!.userId

    const existing = await (db as any).webhookSubscription.findFirst({
      where: { id: req.params.id, userId },
      select: { id: true },
    })
    if (!existing) return sendNotFound(res, 'Webhook subscription')

    await (db as any).webhookSubscription.delete({
      where: { id: req.params.id },
    })

    return res.status(204).send()
  }
)

export default router
