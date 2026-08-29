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
import { getSubscriptionHealth } from '../services/webhookCircuitBreaker'
import { replayDeadLetter } from '../services/webhookDispatcher'
import { logger } from '../utils/logger'

const router = Router()
const prisma = db as any

function isAllowedWebhookUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return false
    const host = parsed.hostname
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host.startsWith('10.') ||
      host.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    ) {
      return false
    }
    return true
  } catch {
    return false
  }
}

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

    if (!isAllowedWebhookUrl(url)) {
      return res.status(400).json({
        error:
          'Webhook URL must be HTTPS and not point to private/local addresses',
      })
    }

    const secret = generateWebhookSecret()

    const subscription = await prisma.webhookSubscription.create({
      data: { userId, url, events, secret },
      select: {
        id: true,
        url: true,
        events: true,
        isActive: true,
        createdAt: true,
      },
    })

    return res.status(201).json({ ...subscription, secret })
  }
)

/** GET /api/webhooks */
router.get('/', async (req: Request, res: Response) => {
  const userId = req.auth!.userId
  const subscriptions = await prisma.webhookSubscription.findMany({
    where: { userId },
    select: {
      id: true,
      url: true,
      events: true,
      isActive: true,
      autoReplay: true,
      secretNextActiveAt: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: { createdAt: 'desc' },
  })
  return res.status(200).json({ subscriptions })
})

router.get(
  '/:id',
  validate({ params: webhookIdParamSchema }),
  async (req: Request, res: Response) => {
    const userId = req.auth!.userId
    const sub = await prisma.webhookSubscription.findFirst({
      where: { id: req.params.id, userId },
      select: {
        id: true,
        url: true,
        events: true,
        isActive: true,
        autoReplay: true,
        secretNextActiveAt: true,
        createdAt: true,
        updatedAt: true,
      },
    })
    if (!sub) return sendNotFound(res, 'Webhook subscription')
    return res.status(200).json(sub)
  }
)

router.patch(
  '/:id',
  validate({ params: webhookIdParamSchema, body: updateWebhookSchema }),
  async (req: Request, res: Response) => {
    const userId = req.auth!.userId
    const existing = await prisma.webhookSubscription.findFirst({
      where: { id: req.params.id, userId },
      select: { id: true },
    })
    if (!existing) return sendNotFound(res, 'Webhook subscription')

    if (req.body.url && !isAllowedWebhookUrl(req.body.url)) {
      return res.status(400).json({ error: 'Invalid webhook URL' })
    }

    const updated = await prisma.webhookSubscription.update({
      where: { id: req.params.id },
      data: req.body,
      select: {
        id: true,
        url: true,
        events: true,
        isActive: true,
        autoReplay: true,
        updatedAt: true,
      },
    })
    return res.status(200).json(updated)
  }
)

router.delete(
  '/:id',
  validate({ params: webhookIdParamSchema }),
  async (req: Request, res: Response) => {
    const userId = req.auth!.userId
    const existing = await prisma.webhookSubscription.findFirst({
      where: { id: req.params.id, userId },
      select: { id: true },
    })
    if (!existing) return sendNotFound(res, 'Webhook subscription')

    await prisma.webhookSubscription.delete({ where: { id: req.params.id } })
    return res.status(204).send()
  }
)

/** POST /api/webhooks/subscriptions/:id/rotate-secret (#377) */
router.post(
  '/:id/rotate-secret',
  validate({ params: webhookIdParamSchema }),
  async (req: Request, res: Response) => {
    const userId = req.auth!.userId
    const existing = await prisma.webhookSubscription.findFirst({
      where: { id: req.params.id, userId },
    })
    if (!existing) return sendNotFound(res, 'Webhook subscription')

    const secretNext = generateWebhookSecret()
    const activeAt = new Date(Date.now() + 24 * 60 * 60 * 1000)

    await prisma.webhookSubscription.update({
      where: { id: req.params.id },
      data: { secretNext, secretNextActiveAt: activeAt },
    })

    return res.status(200).json({
      secretNext,
      secretNextActiveAt: activeAt.toISOString(),
      message:
        'Dual-signing active until promotion. Store the new secret securely.',
    })
  }
)

/** POST /api/webhooks/subscriptions/:id/promote-secret (#377) */
router.post(
  '/:id/promote-secret',
  validate({ params: webhookIdParamSchema }),
  async (req: Request, res: Response) => {
    const userId = req.auth!.userId
    const existing = await prisma.webhookSubscription.findFirst({
      where: { id: req.params.id, userId },
    })
    if (!existing) return sendNotFound(res, 'Webhook subscription')
    if (!existing.secretNext) {
      return res.status(400).json({ error: 'No pending secret to promote' })
    }

    await prisma.webhookSubscription.update({
      where: { id: req.params.id },
      data: {
        secret: existing.secretNext,
        secretNext: null,
        secretNextActiveAt: null,
      },
    })

    return res.status(200).json({ status: 'promoted' })
  }
)

/** GET /api/webhooks/subscriptions/:id/health (#377) */
router.get(
  '/:id/health',
  validate({ params: webhookIdParamSchema }),
  async (req: Request, res: Response) => {
    const userId = req.auth!.userId
    const existing = await prisma.webhookSubscription.findFirst({
      where: { id: req.params.id, userId },
    })
    if (!existing) return sendNotFound(res, 'Webhook subscription')

    const circuit = getSubscriptionHealth(req.params.id)
    const dlqDepth = await prisma.webhookDeadLetter.count({
      where: { subscriptionId: req.params.id, status: 'PENDING' },
    })
    const recentFailures = await prisma.webhookDelivery.count({
      where: {
        subscriptionId: req.params.id,
        status: 'FAILED',
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
    })

    return res.status(200).json({
      subscriptionId: req.params.id,
      circuitState: circuit.state,
      consecutiveFailures: circuit.consecutiveFailures,
      dlqDepth,
      recentFailures24h: recentFailures,
      isActive: existing.isActive,
    })
  }
)

/** POST /api/webhooks/dead-letters/:id/replay (#377) */
router.post('/dead-letters/:id/replay', async (req: Request, res: Response) => {
  const userId = req.auth!.userId
  const dl = await prisma.webhookDeadLetter.findUnique({
    where: { id: req.params.id },
    include: { subscription: { select: { userId: true } } },
  })
  if (!dl || dl.subscription.userId !== userId) {
    return sendNotFound(res, 'Dead letter')
  }

  const ok = await replayDeadLetter(req.params.id)
  if (!ok) {
    return res.status(409).json({ error: 'Dead letter not replayable' })
  }

  logger.info('[Webhook] Manual dead-letter replay', {
    deadLetterId: req.params.id,
    userId,
  })

  return res.status(200).json({ status: 'replayed', id: req.params.id })
})

/** POST /api/webhooks/subscriptions/:id/replay — bulk replay PENDING DLQ (#377) */
router.post(
  '/:id/replay',
  validate({ params: webhookIdParamSchema }),
  async (req: Request, res: Response) => {
    const userId = req.auth!.userId
    const existing = await prisma.webhookSubscription.findFirst({
      where: { id: req.params.id, userId },
    })
    if (!existing) return sendNotFound(res, 'Webhook subscription')

    const since = req.query.since
      ? new Date(String(req.query.since))
      : new Date(Date.now() - 24 * 60 * 60 * 1000)

    const pending = await prisma.webhookDeadLetter.findMany({
      where: {
        subscriptionId: req.params.id,
        status: 'PENDING',
        firstFailedAt: { gte: since },
      },
      take: 50,
      orderBy: { firstFailedAt: 'asc' },
    })

    let replayed = 0
    for (const dl of pending) {
      const ok = await replayDeadLetter(dl.id)
      if (ok) replayed++
    }

    return res.status(200).json({ replayed, total: pending.length })
  }
)

import {
  createEndpoint,
  listEndpoints,
  getEndpoint,
  updateEndpoint,
  deleteEndpoint,
  rotateSecret,
  sendTestPing,
  replayEvents,
  listDeliveries,
} from '../controllers/user-webhook-controller'
import { handleMailWebhook } from '../controllers/email-identity-controller'

// Unauthenticated provider mail webhook callback (#367)
router.post('/mail', handleMailWebhook)

// User-scoped outbound webhook management endpoints (#368)
router.post('/endpoints', createEndpoint)
router.get('/endpoints', listEndpoints)
router.get('/endpoints/:id', getEndpoint)
router.patch('/endpoints/:id', updateEndpoint)
router.delete('/endpoints/:id', deleteEndpoint)
router.post('/endpoints/:id/rotate-secret', rotateSecret)
router.post('/endpoints/:id/test', sendTestPing)
router.post('/endpoints/:id/replay', replayEvents)
router.get('/endpoints/:id/deliveries', listDeliveries)

export default router
