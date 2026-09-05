import { Router, Request, Response } from 'express'
import db from '../db'
import { requireAuth } from '../middleware/authenticate'
import { validate } from '../middleware/validate'
import { sendNotFound } from '../utils/errors'
import { loadDigestData } from '../notifications/load'
import { buildDigest } from '../notifications/digest'
import {
  createDigestSubscriptionSchema,
  updateDigestSubscriptionSchema,
  digestIdParamSchema,
  digestPreviewQuerySchema,
  type DigestFrequency,
} from '../validators/digest-validators'

const router = Router()

router.use(requireAuth)

const digestSelect = {
  id: true,
  userId: true,
  frequency: true,
  channels: true,
  sendHourUtc: true,
  weeklyDayUtc: true,
  quietHours: true,
  isActive: true,
  lastSentAt: true,
  nextRunAt: true,
  createdAt: true,
  updatedAt: true,
} as const

/**
 * A WHATSAPP channel needs a phone on file, and a WEBHOOK channel is only
 * meaningful when the user has registered webhook endpoints. Rejecting an
 * unlinked channel at creation keeps the digest from silently skipping it.
 */
async function validateChannelsLinked(
  userId: string,
  channels: string[]
): Promise<string | null> {
  if (channels.includes('WHATSAPP')) {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { phone: true },
    })
    if (!user?.phone) {
      return 'WHATSAPP requires a linked phone number'
    }
  }
  if (channels.includes('WEBHOOK')) {
    const endpoints = await db.userWebhookEndpoint.count({
      where: { userId, status: 'ACTIVE' },
    })
    if (endpoints === 0) {
      return 'WEBHOOK requires at least one registered webhook endpoint'
    }
  }
  return null
}

/**
 * POST /api/v1/notifications/digests
 * Create a new digest subscription owned by the authenticated user.
 */
router.post(
  '/',
  validate({ body: createDigestSubscriptionSchema }),
  async (req: Request, res: Response) => {
    const userId = req.auth!.userId
    const {
      frequency,
      channels,
      sendHourUtc,
      weeklyDayUtc,
      quietHours,
      isActive,
    } = req.body

    const linkedError = await validateChannelsLinked(userId, channels)
    if (linkedError) {
      return res
        .status(400)
        .json({
          error: 'Validation failed',
          details: [{ message: linkedError }],
        })
    }

    const existing = await db.digestSubscription.findFirst({
      where: { userId, isActive: true },
      select: { id: true },
    })
    if (existing) {
      return res.status(409).json({
        error: 'An active digest subscription already exists',
      })
    }

    const now = new Date()
    // nextRunAt defaults to the next natural occurrence at the preferred hour.
    const { nextOccurrence } = await import('../notifications/schedule')

    const subscription = await db.digestSubscription.create({
      data: {
        userId,
        frequency,
        channels,
        sendHourUtc,
        weeklyDayUtc: weeklyDayUtc ?? null,
        quietHours: quietHours ?? null,
        isActive: isActive ?? true,
        nextRunAt: nextOccurrence(
          frequency as DigestFrequency,
          sendHourUtc,
          weeklyDayUtc ?? null,
          now
        ),
      },
      select: digestSelect,
    })

    return res.status(201).json(subscription)
  }
)

/**
 * GET /api/v1/notifications/digests
 * List the authenticated user's digest subscriptions (owner-scoped).
 */
router.get('/', async (req: Request, res: Response) => {
  const userId = req.auth!.userId
  const subscriptions = await db.digestSubscription.findMany({
    where: { userId },
    select: digestSelect,
    orderBy: { createdAt: 'desc' },
  })
  return res.status(200).json({ subscriptions })
})

/**
 * GET /api/v1/notifications/digests/preview?frequency=WEEKLY
 * Render the digest for the caller right now without scheduling (rate-limited
 * downstream by the global limiter).
 */
router.get(
  '/preview',
  validate({ query: digestPreviewQuerySchema }),
  async (req: Request, res: Response) => {
    const userId = req.auth!.userId
    const frequency = (req.query.frequency as DigestFrequency) ?? 'WEEKLY'
    const data = await loadDigestData(userId, frequency)
    const model = buildDigest(data, frequency)
    return res.status(200).json(model)
  }
)

/**
 * PATCH /api/v1/notifications/digests/:id
 * Update a digest subscription owned by the caller.
 */
router.patch(
  '/:id',
  validate({
    params: digestIdParamSchema,
    body: updateDigestSubscriptionSchema,
  }),
  async (req: Request, res: Response) => {
    const userId = req.auth!.userId

    const existing = await db.digestSubscription.findFirst({
      where: { id: req.params.id, userId },
      select: { id: true, channels: true },
    })
    if (!existing) return sendNotFound(res, 'Digest subscription')

    const nextChannels = req.body.channels ?? existing.channels
    const linkedError = await validateChannelsLinked(userId, nextChannels)
    if (linkedError) {
      return res
        .status(400)
        .json({
          error: 'Validation failed',
          details: [{ message: linkedError }],
        })
    }

    const updated = await db.digestSubscription.update({
      where: { id: req.params.id },
      data: req.body,
      select: digestSelect,
    })

    return res.status(200).json(updated)
  }
)

/**
 * DELETE /api/v1/notifications/digests/:id
 * Delete a digest subscription owned by the caller.
 */
router.delete(
  '/:id',
  validate({ params: digestIdParamSchema }),
  async (req: Request, res: Response) => {
    const userId = req.auth!.userId
    const existing = await db.digestSubscription.findFirst({
      where: { id: req.params.id, userId },
      select: { id: true },
    })
    if (!existing) return sendNotFound(res, 'Digest subscription')

    await db.digestSubscription.delete({ where: { id: req.params.id } })
    return res.status(204).send()
  }
)

export default router
