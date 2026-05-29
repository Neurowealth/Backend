import { NextFunction, Request, Response } from 'express';
import { JwtAdapter } from '../config';
import db from '../db';
import { logger } from '../utils/logger';

export class AuthMiddleware {
  /**
   * Validate JWT from Authorization header, verify session exists in DB and
   * has not expired, then attach userId and stellarPubKey to the request.
   *
   * Returns 401 for:
   *  - Missing / malformed token
   *  - Invalid JWT signature
   *  - Session not found
   *  - Session expired
   */
  static validateJwt = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const authorization = req.header('Authorization');

    if (!authorization) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    if (!authorization.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Invalid Bearer token' });
      return;
    }

    const token = authorization.split(' ')[1] ?? '';

    try {
      // 1. Verify JWT signature and decode payload
      const payload = await JwtAdapter.validateToken<{ id: string }>(token);
      if (!payload) {
        res.status(401).json({ error: 'Invalid token' });
        return;
      }

      // 2. Look up live session in the database (prevents session reuse after logout)
      const session = await db.session.findUnique({
        where: { token },
        include: { user: true },
      });

      if (!session) {
        res.status(401).json({ error: 'Session not found' });
        return;
      }

      // 3. Reject expired sessions
      if (session.expiresAt < new Date()) {
        // Clean up the stale session row
        await db.session.delete({ where: { token } }).catch(() => undefined);
        res.status(401).json({ error: 'Session expired' });
        return;
      }

      // 4. Reject inactive users
      if (!session.user.isActive) {
        res.status(401).json({ error: 'User account is inactive' });
        return;
      }

      // 5. Attach authenticated identity to request
      req.userId = session.user.id;
      req.stellarPubKey = session.walletAddress;
      req.auth = {
        userId: session.userId,
        sessionId: session.id,
        walletAddress: session.walletAddress,
        network: session.network,
      };

      next();
    } catch (error) {
      logger.error('[Auth] Middleware error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  };
}