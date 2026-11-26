/**
 * KYC verification initiation & provider callback routes (#362).
 *
 *   POST /api/v1/kyc/verify            — auth; initiate provider-hosted KYC flow
 *   POST /api/v1/kyc/webhook/:provider — signature-verified provider callback that updates KycProfile.tier
 *
 * Security invariants:
 *   - KYC tier is NEVER accepted from user request input on `/verify`.
 *   - `KycProfile.tier` is only updated by a signature-verified provider callback
 *     or an audited admin override (`POST /api/v1/admin/users/:id/kyc-tier`).
 *   - `KycProfile.providerRef` stores only an opaque provider reference token;
 *     no PII or identity documents are persisted on the platform.
 */
import { Router, Request, Response } from 'express'
import express from 'express'
import { createHmac, timingSafeEqual } from 'crypto'
import { z } from 'zod'
import { requireAuth } from '../middleware/authenticate'
import { validate } from '../middleware/validate'
import { sendError } from '../utils/errors'
import { logger } from '../utils/logger'
import { getDefaultProvider, getProvider } from '../fiat/registry'
import { KYC_TIERS, type KycTierValue } from '../fiat/limits'
import db from '../db'

const router = Router()

const verifyKycRequestSchema = z
  .object({
    provider: z.string().min(1).max(64).optional(),
    redirectUrl: z.string().url().optional(),
  })
  .strict()

const kycWebhookPayloadSchema = z.object({
  userId: z.string().min(1),
  tier: z.enum(KYC_TIERS),
  providerRef: z.string().min(1).max(256),
  verifiedAt: z.string().datetime().optional(),
  reviewNote: z.string().max(1000).optional(),
})

function verifyKycWebhookSignature(
  providerName: string,
  rawBody: string,
  headers: Record<string, string | undefined>
): boolean {
  const kycSecret = process.env.KYC_WEBHOOK_SECRET
  const sigHeader =
    headers['x-kyc-signature'] ??
    headers['x-webhook-signature'] ??
    headers['moonpay-signature-v2']

  if (kycSecret && sigHeader) {
    const expected = createHmac('sha256', kycSecret)
      .update(rawBody)
      .digest('hex')
    const cleanSig = sigHeader.replace(/^sha256=/i, '').trim()
    try {
      const a = Buffer.from(expected, 'utf8')
      const b = Buffer.from(cleanSig, 'utf8')
      if (a.length === b.length && timingSafeEqual(a, b)) {
        return true
      }
    } catch {
      // Fall through to provider verifier.
    }
  }

  try {
    const provider = getProvider(providerName)
    return provider.verifyWebhookSignature(rawBody, headers)
  } catch {
    return false
  }
}

// ── Initiate provider-hosted KYC verification ────────────────────────────────
router.post(
  '/verify',
  requireAuth,
  validate({ body: verifyKycRequestSchema, errorMessage: 'Validation error' }),
  async (req: Request, res: Response) => {
    const userId = req.userId
    if (!userId) return sendError(res, 401, 'Unauthorized')

    // Reject if caller attempted to sneak in a `tier` field (enforced by .strict() too)
    if (req.body && 'tier' in req.body) {
      return sendError(res, 400, 'KYC tier cannot be asserted by client')
    }

    let providerName = req.body?.provider
    try {
      const provider = providerName
        ? getProvider(providerName)
        : getDefaultProvider()
      providerName = provider.name
    } catch {
      return sendError(res, 400, 'Unknown KYC provider')
    }

    const existing =
      typeof (db as any).kycProfile?.findUnique === 'function'
        ? await (db as any).kycProfile.findUnique({ where: { userId } })
        : null

    const currentTier: KycTierValue =
      (existing?.tier as KycTierValue) ?? 'TIER_0'
    const sessionRef = `kyc_${providerName}_${userId.slice(0, 8)}_${Date.now()}`
    const verificationUrl = `https://kyc.${providerName}.example.com/verify?ref=${encodeURIComponent(sessionRef)}`

    logger.info('[KYC] Verification flow initiated', {
      userId,
      provider: providerName,
      currentTier,
    })

    return res.status(200).json({
      provider: providerName,
      status: 'PENDING',
      currentTier,
      providerRef: sessionRef,
      verificationUrl,
    })
  }
)

// ── Provider KYC verification callback (signature-verified) ──────────────────
router.post(
  '/webhook/:provider',
  express.raw({ type: '*/*', limit: '1mb' }),
  async (req: Request, res: Response) => {
    const providerName = req.params.provider

    const rawBody = Buffer.isBuffer(req.body)
      ? req.body.toString('utf8')
      : typeof req.body === 'string'
        ? req.body
        : JSON.stringify(req.body ?? {})

    const headers: Record<string, string | undefined> = {}
    for (const [k, v] of Object.entries(req.headers)) {
      headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v
    }

    if (!verifyKycWebhookSignature(providerName, rawBody, headers)) {
      logger.warn('[KYC] Webhook signature verification failed', {
        provider: providerName,
      })
      return sendError(res, 401, 'Invalid signature')
    }

    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(rawBody)
    } catch {
      return sendError(res, 400, 'Malformed webhook JSON')
    }

    const parsed = kycWebhookPayloadSchema.safeParse(parsedJson)
    if (!parsed.success) {
      return sendError(res, 400, 'Invalid KYC webhook payload')
    }

    const { userId, tier, providerRef, verifiedAt, reviewNote } = parsed.data
    const verifiedTimestamp = verifiedAt
      ? new Date(verifiedAt)
      : tier === 'TIER_0'
        ? null
        : new Date()

    const profile = await (db as any).kycProfile.upsert({
      where: { userId },
      create: {
        userId,
        tier,
        providerRef,
        verifiedAt: verifiedTimestamp,
        reviewNote: reviewNote ?? `Verified via ${providerName} callback`,
      },
      update: {
        tier,
        providerRef,
        verifiedAt: verifiedTimestamp,
        reviewNote: reviewNote ?? `Updated via ${providerName} callback`,
      },
    })

    logger.info('[KYC] User KYC tier updated via verified provider webhook', {
      userId,
      provider: providerName,
      tier: profile.tier,
      providerRef: profile.providerRef,
    })

    return res.status(200).json({
      received: true,
      userId: profile.userId,
      tier: profile.tier,
      providerRef: profile.providerRef,
      verifiedAt: profile.verifiedAt
        ? new Date(profile.verifiedAt).toISOString()
        : null,
    })
  }
)

export default router
