import { Request, Response } from 'express';
import { randomBytes } from 'crypto';
import { Keypair } from '@stellar/stellar-sdk';
import { PrismaClient } from '@prisma/client';
import { JwtAdapter, config } from '../config';
import { logger } from '../utils/logger';
import {
  stellarVerification,
  _nonceStoreForTests as nonceStore,
} from '../utils/stellar/stellar-verification';

const prisma = new PrismaClient();

// Controllers

/**
 * POST /api/auth/challenge
 *
 * Body: { stellarPubKey: string }
 * Returns: { nonce: string, expiresAt: ISO-8601 }
 *
 * Issues a one-time nonce tied to the caller's Stellar public key.
 * The nonce must be signed and returned to /verify within 5 minutes.
 */
export async function challenge(req: Request, res: Response): Promise<void> {
  const { stellarPubKey } = req.body as { stellarPubKey?: string };

  if (!stellarPubKey) {
    res.status(400).json({ error: 'stellarPubKey is required' });
    return;
  }

  // Validate the public key format
  try {
    Keypair.fromPublicKey(stellarPubKey);
  } catch {
    res.status(400).json({ error: 'Invalid Stellar public key' });
    return;
  }

  stellarVerification.purgeExpiredNonces();

  const nonce = `nw-auth-${randomBytes(32).toString('hex')}`;
  const expiresAt = Date.now() + config.jwt.nonce_ttl_ms;

  nonceStore.set(stellarPubKey, { nonce, expiresAt, stellarPubKey });

  logger.info(`[Auth] Challenge issued for ${stellarPubKey}`);

  res.status(200).json({
    nonce,
    expiresAt: new Date(expiresAt).toISOString(),
  });
}

/**
 * POST /api/auth/verify
 *
 * Body: { stellarPubKey: string, signature: string (base64) }
 * Returns: { token: string, userId: string, expiresAt: ISO-8601 }
 *
 * Steps:
 *  1. Look up stored nonce for this public key.
 *  2. Reject expired nonces (replay prevention).
 *  3. Verify Stellar signature over the nonce.
 *  4. Consume nonce to prevent reuse.
 *  5. Create or retrieve user + portfolio position.
 *  6. Issue JWT and store session in DB.
 */
export async function verify(req: Request, res: Response): Promise<void> {
  const { stellarPubKey, signature } = req.body as {
    stellarPubKey?: string;
    signature?: string;
  };

  if (!stellarPubKey || !signature) {
    res.status(400).json({ error: 'stellarPubKey and signature are required' });
    return;
  }

  // 1. Look up nonce
  const stored = nonceStore.get(stellarPubKey);
  if (!stored) {
    res.status(401).json({ error: 'No active challenge for this public key' });
    return;
  }

  // 2. Check nonce expiry
  if (stored.expiresAt <= Date.now()) {
    nonceStore.delete(stellarPubKey);
    res.status(401).json({ error: 'Challenge nonce has expired' });
    return;
  }

  // 3. Verify Stellar signature
  const isValid = stellarVerification.verifyStellarSignature(
    stellarPubKey,
    stored.nonce,
    signature,
  );
  if (!isValid) {
    res.status(401).json({ error: 'Invalid signature' });
    return;
  }

  // 4. Consume nonce — prevents replay attacks
  nonceStore.delete(stellarPubKey);

  const network = stellarVerification.resolveNetwork();

  try {
    // 5. Create or fetch user
    let user = await prisma.user.findUnique({
      where: { walletAddress: stellarPubKey },
    });

    if (!user) {
      // Auto-create user + empty portfolio position
      user = await prisma.user.create({
        data: {
          walletAddress: stellarPubKey,
          network,
          positions: {
            create: {
              protocolName: 'unassigned',
              assetSymbol: 'USDC',
              depositedAmount: 0,
              currentValue: 0,
            },
          },
        },
      });
      logger.info(`[Auth] New user created: ${user.id} (${stellarPubKey})`);
    }

    // 6. Issue JWT
    const expiresAt = new Date(Date.now() + config.jwt.session_ttl_hours * 60 * 60 * 1000);
    const token = await JwtAdapter.generateToken({ id: user.id }, config.jwt.session_ttl_hours);

    if (!token) {
      res.status(500).json({ error: 'Failed to generate token' });
      return;
    }

    // 7. Persist session
    await prisma.session.create({
      data: {
        userId: user.id,
        token,
        walletAddress: stellarPubKey,
        network,
        expiresAt,
        ipAddress: req.ip ?? null,
        userAgent: req.headers['user-agent'] ?? null,
      },
    });

    logger.info(`[Auth] Session created for user ${user.id}`);

    res.status(200).json({
      token,
      userId: user.id,
      expiresAt: expiresAt.toISOString(),
    });
  } catch (error) {
    logger.error('[Auth] Verify error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/auth/logout
 *
 * Requires a valid JWT (via AuthMiddleware.validateJwt).
 * Deletes the session from the database so the token cannot be reused.
 */
export async function logout(req: Request, res: Response): Promise<void> {
  const authorization = req.header('Authorization') ?? '';
  const token = authorization.split(' ')[1] ?? '';

  try {
    await prisma.session.deleteMany({ where: { token } });
    logger.info(`[Auth] Session revoked for user ${req.userId}`);
    res.status(200).json({ message: 'Logged out successfully' });
  } catch (error) {
    logger.error('[Auth] Logout error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// Re-export so tests can import from either the controller or stellar-verification
export { _nonceStoreForTests } from '../utils/stellar/stellar-verification';
