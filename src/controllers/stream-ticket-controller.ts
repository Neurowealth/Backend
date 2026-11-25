import { Request, Response } from 'express'
import { createStreamTicket } from '../middleware/streamAuth'
import { checkSubAccountPermission } from '../middleware/subAccount'
import { logger } from '../utils/logger'

export async function issueStreamTicket(
  req: Request,
  res: Response
): Promise<void> {
  const viewerUserId = (req as any).user?.id || (req as any).userId
  if (!viewerUserId) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const { actor } = req.query
  const requestedStreamUserId =
    typeof actor === 'string' && actor.trim() ? actor.trim() : viewerUserId

  let streamUserId = requestedStreamUserId
  let allowedTopics = undefined

  if (streamUserId !== viewerUserId) {
    const result = await checkSubAccountPermission(
      viewerUserId,
      streamUserId,
      'VIEW'
    )

    if (!result.allowed) {
      logger.warn(
        '[StreamTicket] Access denied for requested streamUserId',
        {
          viewerUserId,
          requestedStreamUserId,
          reason: result.reason,
        }
      )
      res.status(403).json({ error: 'Forbidden' })
      return
    }
  }

  const ticket = createStreamTicket(
    viewerUserId,
    streamUserId,
    allowedTopics
  )

  res.json({
    ticket,
    ttlSeconds: 60,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  })
}
