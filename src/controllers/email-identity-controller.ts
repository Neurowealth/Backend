import crypto from 'node:crypto'
import { Request, Response } from 'express'
import db from '../db'
import { logger } from '../utils/logger'
import { mailRegistry } from '../mail/mailProvider'
import { renderEmailVerification } from '../mail/templates'
import { publishUserEvent } from '../events/publisher'
import { getAuthUserId } from '../utils/auth'
import {
  requestEmailVerificationSchema,
  verifyEmailTokenSchema,
} from '../validators/email-validators'

export async function requestEmailVerification(
  req: Request,
  res: Response
): Promise<void> {
  const userId = getAuthUserId(req)

  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  // Zod owns validation *and* normalisation, so the stored address is always in
  // the canonical lowercased/trimmed form.
  const parsed = requestEmailVerificationSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({
      error:
        parsed.error.issues[0]?.message ?? 'Valid email address is required',
    })
    return
  }

  const normalizedEmail = parsed.data.email

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
  const parsed = verifyEmailTokenSchema.safeParse(req.query)
  if (!parsed.success) {
    res.status(400).json({ error: 'Verification token is required' })
    return
  }

  const token = parsed.data.token

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
    const event = await mailRegistry.parseWebhook(
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
    // SES delivers only cryptographically signed SNS envelopes (#524). A body
    // that fails verification is an unauthenticated caller, not a malformed
    // one: 401, logged, and never processed. The code check (plain string)
    // survives the mailProvider module being mocked under unit test.
    if (
      err &&
      (err as { code?: string }).code === 'SES_WEBHOOK_SIGNATURE_INVALID'
    ) {
      logger.warn(
        '[EmailIdentityController] Rejected mail webhook: SNS signature verification failed',
        { reason: err?.reason, error: err.message }
      )
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    logger.error('[EmailIdentityController] Failed to process mail webhook', {
      error: err.message,
    })
    res.status(500).json({ error: 'Failed to process mail webhook' })
  }
}
