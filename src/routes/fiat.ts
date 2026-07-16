/**
 * Fiat on-ramp / off-ramp routes (#290).
 *
 *   POST /api/fiat/quote            — auth; get a buy/sell quote
 *   POST /api/fiat/orders           — auth; create an order, returns checkout URL
 *   GET  /api/fiat/orders           — auth; caller's order history
 *   GET  /api/fiat/orders/:id       — auth; single order (owner-scoped)
 *   POST /api/fiat/webhook/:provider — provider callback (signature-verified, no JWT)
 *
 * The webhook route parses its own RAW body (express.raw) so the provider HMAC
 * signature is verified over the exact received bytes — the global JSON parser
 * would otherwise reshape the payload and break verification.
 */
import { Router, Request, Response } from 'express'
import express from 'express'
import { requireAuth, enforceUserAccess } from '../middleware/authenticate'
import { validate } from '../middleware/validate'
import { logger } from '../utils/logger'
import { sendError } from '../utils/errors'
import {
  fiatQuoteSchema,
  createFiatOrderSchema,
} from '../validators/fiat-validators'
import {
  getFiatQuote,
  createFiatOrder,
  processProviderWebhook,
} from '../fiat/service'
import { getProvider } from '../fiat/registry'
import db from '../db'

const router = Router()

// ── Quote ─────────────────────────────────────────────────────────────────────
router.post(
  '/quote',
  requireAuth,
  validate({ body: fiatQuoteSchema, errorMessage: 'Validation error' }),
  async (req: Request, res: Response) => {
    try {
      const quote = await getFiatQuote(req.body)
      return res.json(quote)
    } catch (err) {
      logger.error('[Fiat] Quote failed', {
        error: err instanceof Error ? err.message : String(err),
      })
      return sendError(res, 502, 'Failed to fetch quote from provider')
    }
  },
)

// ── Create order ────────────────────────────────────────────────────────────
router.post(
  '/orders',
  requireAuth,
  validate({ body: createFiatOrderSchema, errorMessage: 'Validation error' }),
  enforceUserAccess,
  async (req: Request, res: Response) => {
    const walletAddress = req.auth?.walletAddress
    if (!walletAddress) {
      return sendError(res, 401, 'Unauthorized')
    }

    try {
      const order = await createFiatOrder(req.body, { walletAddress })
      return res.status(201).json(order)
    } catch (err) {
      logger.error('[Fiat] Order creation failed', {
        error: err instanceof Error ? err.message : String(err),
      })
      return sendError(res, 502, 'Failed to create order with provider')
    }
  },
)

// ── Order history (caller-scoped) ─────────────────────────────────────────────
router.get('/orders', requireAuth, async (req: Request, res: Response) => {
  const userId = req.userId
  if (!userId) return sendError(res, 401, 'Unauthorized')

  const orders = await (db as any).fiatOrder.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })
  return res.json({ orders })
})

// ── Single order (owner-scoped) ───────────────────────────────────────────────
router.get('/orders/:id', requireAuth, async (req: Request, res: Response) => {
  const userId = req.userId
  if (!userId) return sendError(res, 401, 'Unauthorized')

  const order = await (db as any).fiatOrder.findUnique({
    where: { id: req.params.id },
  })
  if (!order || order.userId !== userId) {
    // Don't leak existence of other users' orders — 404 either way.
    return sendError(res, 404, 'Order not found')
  }
  return res.json(order)
})

// ── Provider webhook ──────────────────────────────────────────────────────────
// Raw body parser scoped to this route only. No JWT: authenticity is proven by
// the provider signature. Always ACK 2xx once verified so the provider stops
// retrying, even when the order is unknown/terminal (handled idempotently).
router.post(
  '/webhook/:provider',
  express.raw({ type: '*/*', limit: '1mb' }),
  async (req: Request, res: Response) => {
    const providerName = req.params.provider

    let provider
    try {
      provider = getProvider(providerName)
    } catch {
      return sendError(res, 404, 'Unknown provider')
    }

    const rawBody = Buffer.isBuffer(req.body)
      ? req.body.toString('utf8')
      : typeof req.body === 'string'
        ? req.body
        : JSON.stringify(req.body ?? {})

    // Normalize header keys to lower-case for the provider verifier.
    const headers: Record<string, string | undefined> = {}
    for (const [k, v] of Object.entries(req.headers)) {
      headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v
    }

    if (!provider.verifyWebhookSignature(rawBody, headers)) {
      logger.warn('[Fiat] Webhook signature verification failed', { provider: providerName })
      return sendError(res, 401, 'Invalid signature')
    }

    let parsed
    try {
      parsed = provider.parseWebhookPayload(rawBody)
    } catch (err) {
      logger.error('[Fiat] Webhook payload parse failed', {
        provider: providerName,
        error: err instanceof Error ? err.message : String(err),
      })
      return sendError(res, 400, 'Malformed webhook payload')
    }

    try {
      const result = await processProviderWebhook(providerName, parsed)
      // 200 regardless of handled/unknown — signature was valid; we don't want
      // the provider retrying a well-formed, authenticated delivery.
      return res.status(200).json({ received: true, ...result })
    } catch (err) {
      // Processing error (e.g. DB): 500 so the provider retries later.
      logger.error('[Fiat] Webhook processing error', {
        provider: providerName,
        error: err instanceof Error ? err.message : String(err),
      })
      return sendError(res, 500, 'Webhook processing failed')
    }
  },
)

export default router
