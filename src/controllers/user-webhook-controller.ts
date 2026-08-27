import crypto from 'node:crypto'
import { Request, Response } from 'express'
import db from '../db'
import { logger } from '../utils/logger'
import {
  validateSsrfUrl,
  hashSecret,
  enqueueUserWebhooks,
} from '../services/userWebhookDispatcher'
import { validateFilterPredicate } from '../utils/userWebhookFilter'

export async function createEndpoint(
  req: Request,
  res: Response
): Promise<void> {
  const userId = (req as any).user?.id || (req as any).userId
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const { url, events = [], topicScope = [], filterJson = null } = req.body

  if (!url || typeof url !== 'string') {
    res.status(400).json({ error: 'Valid URL is required' })
    return
  }

  try {
    validateSsrfUrl(url)
  } catch (err: any) {
    res.status(400).json({ error: err.message })
    return
  }

  if (filterJson) {
    try {
      validateFilterPredicate(filterJson)
    } catch (err: any) {
      res.status(400).json({ error: `Invalid filterJson: ${err.message}` })
      return
    }
  }

  const rawSecret = `whsec_${crypto.randomBytes(24).toString('hex')}`
  const secretHash = hashSecret(rawSecret)

  try {
    const endpoint = await db.userWebhookEndpoint.create({
      data: {
        userId,
        url,
        secretHash,
        events: Array.isArray(events) ? events : [],
        topicScope: Array.isArray(topicScope) ? topicScope : [],
        filterJson: filterJson || undefined,
        status: 'ACTIVE',
      },
    })

    res.status(201).json({
      endpoint: {
        id: endpoint.id,
        userId: endpoint.userId,
        url: endpoint.url,
        events: endpoint.events,
        topicScope: endpoint.topicScope,
        filterJson: endpoint.filterJson,
        status: endpoint.status,
        createdAt: endpoint.createdAt,
      },
      secret: rawSecret, // Returned ONLY ONCE on creation
    })
  } catch (err: any) {
    logger.error('[UserWebhookController] Failed to create endpoint', {
      error: err.message,
    })
    res.status(500).json({ error: 'Failed to create webhook endpoint' })
  }
}

export async function listEndpoints(
  req: Request,
  res: Response
): Promise<void> {
  const userId = (req as any).user?.id || (req as any).userId
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  try {
    const endpoints = await db.userWebhookEndpoint.findMany({
      where: { userId },
      select: {
        id: true,
        userId: true,
        url: true,
        events: true,
        topicScope: true,
        filterJson: true,
        status: true,
        consecutiveFailures: true,
        lastDeliveryAt: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: 'desc' },
    })

    res.json({ endpoints })
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to list webhook endpoints' })
  }
}

export async function getEndpoint(req: Request, res: Response): Promise<void> {
  const userId = (req as any).user?.id || (req as any).userId
  const { id } = req.params

  try {
    const endpoint = await db.userWebhookEndpoint.findFirst({
      where: { id, userId },
      select: {
        id: true,
        userId: true,
        url: true,
        events: true,
        topicScope: true,
        filterJson: true,
        status: true,
        consecutiveFailures: true,
        lastDeliveryAt: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    if (!endpoint) {
      res.status(404).json({ error: 'Endpoint not found' })
      return
    }

    res.json({ endpoint })
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to fetch endpoint' })
  }
}

export async function updateEndpoint(
  req: Request,
  res: Response
): Promise<void> {
  const userId = (req as any).user?.id || (req as any).userId
  const { id } = req.params
  const { url, events, topicScope, filterJson, status } = req.body

  try {
    const existing = await db.userWebhookEndpoint.findFirst({
      where: { id, userId },
    })
    if (!existing) {
      res.status(404).json({ error: 'Endpoint not found' })
      return
    }

    if (url) {
      validateSsrfUrl(url)
    }

    if (filterJson) {
      validateFilterPredicate(filterJson)
    }

    const updated = await db.userWebhookEndpoint.update({
      where: { id },
      data: {
        ...(url && { url }),
        ...(events && Array.isArray(events) && { events }),
        ...(topicScope && Array.isArray(topicScope) && { topicScope }),
        ...(filterJson !== undefined && { filterJson }),
        ...(status && { status }),
      },
      select: {
        id: true,
        userId: true,
        url: true,
        events: true,
        topicScope: true,
        filterJson: true,
        status: true,
        updatedAt: true,
      },
    })

    res.json({ endpoint: updated })
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to update endpoint' })
  }
}

export async function deleteEndpoint(
  req: Request,
  res: Response
): Promise<void> {
  const userId = (req as any).user?.id || (req as any).userId
  const { id } = req.params

  try {
    const existing = await db.userWebhookEndpoint.findFirst({
      where: { id, userId },
    })
    if (!existing) {
      res.status(404).json({ error: 'Endpoint not found' })
      return
    }

    await db.userWebhookEndpoint.delete({ where: { id } })
    res.json({ success: true, message: 'Endpoint deleted successfully' })
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to delete endpoint' })
  }
}

export async function rotateSecret(req: Request, res: Response): Promise<void> {
  const userId = (req as any).user?.id || (req as any).userId
  const { id } = req.params

  try {
    const existing = await db.userWebhookEndpoint.findFirst({
      where: { id, userId },
    })
    if (!existing) {
      res.status(404).json({ error: 'Endpoint not found' })
      return
    }

    const newSecret = `whsec_${crypto.randomBytes(24).toString('hex')}`
    const secretHash = hashSecret(newSecret)

    await db.userWebhookEndpoint.update({
      where: { id },
      data: { secretHash },
    })

    res.json({
      success: true,
      endpointId: id,
      secret: newSecret, // Returned ONCE on rotation
    })
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to rotate secret' })
  }
}

export async function sendTestPing(req: Request, res: Response): Promise<void> {
  const userId = (req as any).user?.id || (req as any).userId
  const { id } = req.params

  try {
    const endpoint = await db.userWebhookEndpoint.findFirst({
      where: { id, userId },
    })
    if (!endpoint) {
      res.status(404).json({ error: 'Endpoint not found' })
      return
    }

    const testSeq = Math.floor(Date.now() / 1000)
    const testPayload = {
      event: 'webhook.test',
      timestamp: new Date().toISOString(),
      message: 'Test ping event from NeuroWealth user webhooks',
    }

    await enqueueUserWebhooks(
      userId,
      'alerts',
      'webhook.test',
      testSeq,
      testPayload
    )

    res.json({ success: true, message: 'Test webhook event enqueued' })
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to send test ping' })
  }
}

export async function replayEvents(req: Request, res: Response): Promise<void> {
  const userId = (req as any).user?.id || (req as any).userId
  const { id } = req.params
  const afterSeq = parseInt((req.query.afterSeq as string) || '0', 10)

  try {
    const endpoint = await db.userWebhookEndpoint.findFirst({
      where: { id, userId },
    })
    if (!endpoint) {
      res.status(404).json({ error: 'Endpoint not found' })
      return
    }

    // Query durable UserEvent stream
    const events = await db.userEvent.findMany({
      where: {
        userId,
        seq: { gt: BigInt(afterSeq) },
      },
      orderBy: { seq: 'asc' },
      take: 100,
    })

    let earliestAvailableSeq = afterSeq
    if (events.length > 0) {
      earliestAvailableSeq = Number(events[0].seq)
    } else {
      const earliest = await db.userEvent.findFirst({
        where: { userId },
        orderBy: { seq: 'asc' },
      })
      if (earliest) earliestAvailableSeq = Number(earliest.seq)
    }

    let enqueuedCount = 0
    for (const evt of events) {
      try {
        await db.userWebhookDelivery.create({
          data: {
            endpointId: id,
            userEventSeq: Number(evt.seq),
            eventType: evt.type,
            status: 'PENDING',
            attempts: 0,
            nextAttemptAt: new Date(),
          },
        })
        enqueuedCount++
      } catch (err: any) {
        // Skip duplicate
      }
    }

    res.json({
      success: true,
      endpointId: id,
      replayedEventsCount: enqueuedCount,
      requestedAfterSeq: afterSeq,
      earliestAvailableSeq,
    })
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to replay events' })
  }
}

export async function listDeliveries(
  req: Request,
  res: Response
): Promise<void> {
  const userId = (req as any).user?.id || (req as any).userId
  const { id } = req.params

  try {
    const endpoint = await db.userWebhookEndpoint.findFirst({
      where: { id, userId },
    })
    if (!endpoint) {
      res.status(404).json({ error: 'Endpoint not found' })
      return
    }

    const deliveries = await db.userWebhookDelivery.findMany({
      where: { endpointId: id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })

    res.json({ deliveries })
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to list deliveries' })
  }
}
