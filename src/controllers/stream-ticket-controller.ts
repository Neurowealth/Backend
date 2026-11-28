import { Request, Response } from 'express'
import { createStreamTicket } from '../middleware/streamAuth'

export async function issueStreamTicket(
  req: Request,
  res: Response
): Promise<void> {
  const viewerUserId = req.auth?.userId
  if (!viewerUserId) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const ticket = createStreamTicket(viewerUserId, viewerUserId)

  res.json({
    ticket,
    ttlSeconds: 60,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  })
}
