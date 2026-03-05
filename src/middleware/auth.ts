import { NextFunction, Request, Response } from 'express'
import db from '../db'

function getBearerToken(req: Request): string | null {
  const header = req.headers.authorization
  if (!header) return null
  const [scheme, token] = header.split(' ')
  if (scheme !== 'Bearer' || !token) return null
  return token
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const token = getBearerToken(req)
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const session = await db.session.findUnique({
    where: { token },
    include: { user: true },
  })

  if (!session || session.expiresAt < new Date() || !session.user.isActive) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  req.auth = {
    userId: session.userId,
    sessionId: session.id,
    walletAddress: session.walletAddress,
    network: session.network,
  }

  return next()
}

export function enforceUserAccess(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const requestedUserId = (req.params.userId || req.body?.userId) as
    | string
    | undefined

  if (!req.auth || (requestedUserId && req.auth.userId !== requestedUserId)) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  return next()
}
