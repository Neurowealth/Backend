import { Request, Response, NextFunction } from 'express'
import { db } from '../db'
import { logger } from '../utils/logger'

declare global {
  namespace Express {
    interface Request {
      userId?: string
      token?: string
    }
  }
}

export async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Unauthorized', message: 'Missing or invalid token' })
      return
    }

    const token = authHeader.slice(7) // Remove 'Bearer '

    // Verify token exists and hasn't expired
    const session = await db.session.findUnique({
      where: { token },
      include: { user: true }
    })

    if (!session) {
      res.status(401).json({ error: 'Unauthorized', message: 'Invalid token' })
      return
    }

    if (new Date() > session.expiresAt) {
      res.status(401).json({ error: 'Unauthorized', message: 'Token expired' })
      return
    }

    // Attach user info to request
    req.userId = session.userId
    req.token = token

    next()
  } catch (error) {
    logger.error('Authentication error', { error })
    res.status(500).json({ error: 'Internal server error' })
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.userId) {
    res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' })
    return
  }
  next()
}
