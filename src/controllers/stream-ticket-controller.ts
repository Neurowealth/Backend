import { Request, Response } from 'express'
import { createStreamTicket } from '../middleware/streamAuth'

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
  const streamUserId =
    typeof actor === 'string' && actor.trim() ? actor.trim() : viewerUserId

  const ticket = createStreamTicket(viewerUserId, streamUserId)

  res.json({
    ticket,
    ttlSeconds: 60,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  })
}
