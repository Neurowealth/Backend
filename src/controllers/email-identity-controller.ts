import crypto from 'node:crypto'
import { Request, Response } from 'express'
import db from '../db'
import { logger } from '../utils/logger'
import { mailRegistry } from '../mail/mailProvider'
import { renderEmailVerification } from '../mail/templates'
import { publishUserEvent } from '../events/publisher'

export async function requestEmailVerification(
  req: Request,
  res: Response
): Promise<void> {
  const userId = (req as any).user?.id || (req as any).userId
  const { email } = req.body

  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  if (!email || typeof email !== 'string' || !email.includes('@')) {
    res.status(400).json({ error: 'Valid email address is required' })
    return
  }

  const normalizedEmail = email.trim().toLowerCase()

  try {
    // Check if email is already verified by another user
    const existing = await db.emailIdentity.findUnique({
      where: { email: normalizedEmail },
    })
    if (
      existing &&
      existing.userId !== userId &&
      existing.status === 'VERIFIED'
    ) {
      // Return generic success message to prevent account enumeration
      res.json({
        success: true,
        message: 'Verification email sent if address is valid',
      })
      return
    }

    const rawToken = crypto.randomBytes(32).toString('hex')
    const verifyTokenHash = crypto
      .createHash('sha256')
      .update(rawToken)
      .digest('hex')
    const verifyExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000) // 24h TTL

    const identity = await db.emailIdentity.upsert({
      where: { userId },
      create: {
        userId,
        email: normalizedEmail,
        status: 'PENDING',
        verifyTokenHash,
        verifyExpiresAt,
      },
      update: {
        email: normalizedEmail,
        status: 'PENDING',
        verifiedAt: null,
        verifyTokenHash,
        verifyExpiresAt,
      },
    })

    const verifyUrl = `${process.env.APP_URL || 'https://neurowealth.app'}/api/v1/notifications/email/verify?token=${rawToken}`
    const emailMsg = renderEmailVerification(normalizedEmail, verifyUrl)
    await mailRegistry.send(emailMsg)

    res.json({
      success: true,
      message: 'Verification email sent',
      email: identity.email,
      status: identity.status,
    })
  } catch (err: any) {
    logger.error(
      '[EmailIdentityController] Failed to request email verification',
      { error: err.message }
    )
    res
      .status(500)
      .json({ error: 'Failed to process email verification request' })
  }
}

export async function verifyEmail(req: Request, res: Response): Promise<void> {
  const token =
    typeof req.query.token === 'string' ? req.query.token.trim() : null

  if (!token) {
    res.status(400).json({ error: 'Verification token is required' })
    return
  }

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex')

  try {
    const identity = await db.emailIdentity.findFirst({
      where: {
        verifyTokenHash: tokenHash,
        verifyExpiresAt: { gte: new Date() },
      },
    })

    if (!identity) {
      res.status(400).json({ error: 'Invalid or expired verification token' })
      return
    }

    if (identity.status === 'VERIFIED') {
      res.json({ success: true, message: 'Email address is already verified' })
      return
    }

    const updated = await db.emailIdentity.update({
      where: { id: identity.id },
      data: {
        status: 'VERIFIED',
        verifiedAt: new Date(),
        verifyTokenHash: null,
        verifyExpiresAt: null,
      },
    })

    await publishUserEvent(identity.userId, 'alerts', 'email.verified' as any, {
      email: updated.email,
      verifiedAt: updated.verifiedAt?.toISOString(),
    })

    res.json({
      success: true,
      message: 'Email address verified successfully',
      email: updated.email,
      status: updated.status,
    })
  } catch (err: any) {
    logger.error('[EmailIdentityController] Failed to verify email token', {
      error: err.message,
    })
    res.status(500).json({ error: 'Failed to verify email' })
  }
}

export async function handleMailWebhook(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const event = mailRegistry.parseWebhook(
      req.body,
      req.headers['x-signature'] as string
    )

    if (!event) {
      res.status(400).json({ error: 'Invalid mail webhook payload' })
      return
    }

    if (event.type === 'bounce' || event.type === 'complaint') {
      const newStatus = event.type === 'bounce' ? 'BOUNCED' : 'COMPLAINED'

      const identity = await db.emailIdentity.findFirst({
        where: { email: event.recipient.toLowerCase() },
      })

      if (identity) {
        await db.emailIdentity.update({
          where: { id: identity.id },
          data: {
            status: newStatus,
            lastBounceAt: new Date(),
          },
        })

        await publishUserEvent(
          identity.userId,
          'alerts',
          'notification.email_suppressed' as any,
          {
            email: identity.email,
            reason: event.reason || newStatus,
            suppressedAt: new Date().toISOString(),
          }
        )
      }
    }

    res.json({ success: true, message: 'Mail webhook processed' })
  } catch (err: any) {
    logger.error('[EmailIdentityController] Failed to process mail webhook', {
      error: err.message,
    })
    res.status(500).json({ error: 'Failed to process mail webhook' })
  }
}
