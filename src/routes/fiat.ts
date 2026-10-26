/**
 * Fiat on-ramp / off-ramp routes (#290, extended #313).
 *
 *   POST /api/fiat/quote            — auth; single default-provider quote (legacy)
 *   GET  /api/fiat/quotes           — auth; best-execution: ranked, parallel, multi-provider
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
import { requireScope } from '../middleware/apiKeyAuth'
import { idempotent } from '../middleware/idempotency'
import { validate } from '../middleware/validate'
import { logger } from '../utils/logger'
import { sendError } from '../utils/errors'
import {
  fiatQuoteSchema,
  bestExecutionQuoteQuerySchema,
  createFiatOrderSchema,
  createFiatPurchasePlanSchema,
  updateFiatPurchasePlanSchema,
  fiatPurchasePlanIdParamSchema,
  fiatPurchasePlanPreviewQuerySchema,
  fiatPurchasePlanRunsQuerySchema,
} from '../validators/fiat-validators'
import {
  getFiatQuote,
  getBestExecutionQuote,
  createFiatOrder,
  hasProviderWebhookReplay,
  processProviderWebhook,
  recordProviderWebhookDelivery,
} from '../fiat/service'
import {
  calculateNextFiatPurchaseRun,
  generateFiatPurchasePreview,
  isUserComplianceFrozen,
  recordPlanAuditEntry,
} from '../jobs/fiatPurchases'
import {
  requireSubAccountPermission,
  checkSubAccountPermission,
} from '../middleware/subAccount'
import { getProvider } from '../fiat/registry'
import { NoHealthyProvidersError, FiatOrderError } from '../fiat/types'
import db from '../db'

const router = Router()

function respondToFiatError(
  res: Response,
  err: unknown,
  fallbackMessage: string
) {
  if (err instanceof NoHealthyProvidersError) {
    return sendError(res, 503, 'No healthy fiat providers are available', {
      code: err.code,
      failures: err.failures,
    })
  }
  if (err instanceof FiatOrderError) {
    return sendError(res, err.status, err.message, {
      code: err.code,
      ...err.details,
    })
  }
  logger.error(`[Fiat] ${fallbackMessage}`, {
    error: err instanceof Error ? err.message : String(err),
  })
  return sendError(res, 502, fallbackMessage)
}

// ── Quote (legacy: single default-provider quote) ──────────────────────────
router.post(
  '/quote',
  requireAuth,
  validate({ body: fiatQuoteSchema, errorMessage: 'Validation error' }),
  async (req: Request, res: Response) => {
    try {
      const quote = await getFiatQuote(req.body)
      return res.json(quote)
    } catch (err) {
      return respondToFiatError(res, err, 'Failed to fetch quote from provider')
    }
  }
)

// ── Best-execution quote: ranked, parallel, multi-provider (#313) ──────────
router.get(
  '/quotes',
  requireAuth,
  validate({
    query: bestExecutionQuoteQuerySchema,
    errorMessage: 'Validation error',
  }),
  async (req: Request, res: Response) => {
    const userId = req.userId
    if (!userId) return sendError(res, 401, 'Unauthorized')

    try {
      const result = await getBestExecutionQuote(req.query as any, { userId })
      return res.json(result)
    } catch (err) {
      return respondToFiatError(
        res,
        err,
        'Failed to fetch quotes from providers'
      )
    }
  }
)

// ── Create order ────────────────────────────────────────────────────────────
router.post(
  '/orders',
  requireAuth,
  requireScope('fiat:write'),
  idempotent({ required: true, failClosed: true, ttlSeconds: 86400 }),
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
      return respondToFiatError(
        res,
        err,
        'Failed to create order with provider'
      )
    }
  }
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
      logger.warn('[Fiat] Webhook signature verification failed', {
        provider: providerName,
      })
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
      if (await hasProviderWebhookReplay(providerName, rawBody)) {
        return res.status(200).json({ received: true, replay: true })
      }
    } catch (err) {
      logger.error('[Fiat] Webhook replay check failed', {
        provider: providerName,
        error: err instanceof Error ? err.message : String(err),
      })
      return sendError(res, 500, 'Webhook replay check failed')
    }

    try {
      const result = await processProviderWebhook(providerName, parsed)
      await recordProviderWebhookDelivery(providerName, rawBody)
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
  }
)

// ── Scheduled Fiat Purchase Plans (Card-Funded DCA, #361) ───────────────────

async function ensureSubAccountDepositPermission(
  actorUserId: string,
  targetUserId: string
): Promise<{ allowed: boolean; reason?: string }> {
  if (actorUserId !== targetUserId) {
    const check = await checkSubAccountPermission(
      actorUserId,
      targetUserId,
      'DEPOSIT'
    )
    if (!check.allowed) {
      return { allowed: false, reason: check.reason }
    }
    return { allowed: true }
  }

  // If the authenticated user is itself a child sub-account, verify it holds DEPOSIT permission
  const childLink = await (db as any).subAccount?.findFirst?.({
    where: { childUserId: targetUserId, status: 'ACTIVE' },
  })
  if (childLink && !childLink.permissions?.includes('DEPOSIT')) {
    return { allowed: false, reason: 'no_permission' }
  }

  return { allowed: true }
}

router.post(
  '/purchase-plans',
  requireAuth,
  requireScope('fiat:write'),
  idempotent({ required: false, failClosed: true, ttlSeconds: 86400 }),
  validate({ body: createFiatPurchasePlanSchema, errorMessage: 'Validation error' }),
  requireSubAccountPermission('DEPOSIT'),
  async (req: Request, res: Response) => {
    const actorUserId = req.auth?.userId ?? req.userId
    if (!actorUserId) {
      return sendError(res, 401, 'Unauthorized')
    }

    const targetUserId = req.body.userId ?? actorUserId
    const perm = await ensureSubAccountDepositPermission(
      actorUserId,
      targetUserId
    )
    if (!perm.allowed) {
      return res.status(403).json({
        error: 'Forbidden',
        required: 'DEPOSIT',
      })
    }

    const user = await (db as any).user.findUnique({
      where: { id: targetUserId },
    })
    if (!user) {
      return sendError(res, 404, 'User not found')
    }
    const freezeCheck = await isUserComplianceFrozen(targetUserId, db)
    if (user.isFrozen || freezeCheck.frozen) {
      return sendError(
        res,
        403,
        'Account is frozen due to a compliance hold; cannot create purchase plan'
      )
    }

    let baselineRate: number | null =
      req.body.baselineRate !== undefined ? req.body.baselineRate : null
    if (baselineRate === null) {
      try {
        const quoteResult = await getBestExecutionQuote(
          {
            direction: 'ON_RAMP',
            fiatAmount: Number(req.body.fiatAmount),
            fiatCurrency: req.body.fiatCurrency,
            assetSymbol: req.body.assetSymbol,
          },
          { userId: targetUserId },
          db
        )
        if (quoteResult.best) {
          baselineRate =
            quoteResult.best.rate ??
            (Number(req.body.fiatAmount) > 0
              ? Number(quoteResult.best.cryptoAmount) /
                Number(req.body.fiatAmount)
              : null)
        }
      } catch {
        // Non-fatal: baselineRate will be captured on first quote/run
      }
    }

    const nextRunAt = calculateNextFiatPurchaseRun(req.body.cadence)
    const plan = await (db as any).fiatPurchasePlan.create({
      data: {
        userId: targetUserId,
        fiatAmount: req.body.fiatAmount,
        fiatCurrency: req.body.fiatCurrency,
        assetSymbol: req.body.assetSymbol,
        paymentMethodRef: req.body.paymentMethodRef,
        cadence: req.body.cadence,
        nextRunAt,
        status: 'ACTIVE',
        autoDeposit: req.body.autoDeposit ?? true,
        maxSlippagePct: req.body.maxSlippagePct ?? null,
        baselineRate,
        retryPolicy: req.body.retryPolicy ?? {
          maxAttempts: 3,
          backoffMinutes: 15,
        },
        consecutiveFailures: 0,
      },
    })

    await recordPlanAuditEntry(db, 'PLAN_CREATED', {
      planId: plan.id,
      actorUserId,
      userId: plan.userId,
      fiatAmount: Number(plan.fiatAmount),
      fiatCurrency: plan.fiatCurrency,
      assetSymbol: plan.assetSymbol,
      cadence: plan.cadence,
      autoDeposit: plan.autoDeposit,
      maxSlippagePct: plan.maxSlippagePct
        ? Number(plan.maxSlippagePct)
        : null,
      status: plan.status,
    })

    return res.status(201).json({ plan })
  }
)

router.get(
  '/purchase-plans',
  requireAuth,
  async (req: Request, res: Response) => {
    const actorUserId = req.auth?.userId ?? req.userId
    if (!actorUserId) {
      return sendError(res, 401, 'Unauthorized')
    }

    const requestedUserId =
      typeof req.query.userId === 'string' ? req.query.userId : actorUserId
    if (requestedUserId !== actorUserId) {
      const check = await checkSubAccountPermission(
        actorUserId,
        requestedUserId,
        'VIEW'
      )
      if (!check.allowed) {
        return res.status(403).json({ error: 'Forbidden' })
      }
    }

    const plans = await (db as any).fiatPurchasePlan.findMany({
      where: { userId: requestedUserId },
      orderBy: { createdAt: 'desc' },
    })
    return res.json({ plans })
  }
)

router.get(
  '/purchase-plans/:id',
  requireAuth,
  validate({
    params: fiatPurchasePlanIdParamSchema,
    errorMessage: 'Validation error',
  }),
  async (req: Request, res: Response) => {
    const actorUserId = req.auth?.userId ?? req.userId
    if (!actorUserId) {
      return sendError(res, 401, 'Unauthorized')
    }

    const plan = await (db as any).fiatPurchasePlan.findUnique({
      where: { id: req.params.id },
    })
    if (!plan) {
      return sendError(res, 404, 'Purchase plan not found')
    }
    if (plan.userId !== actorUserId) {
      const check = await checkSubAccountPermission(
        actorUserId,
        plan.userId,
        'VIEW'
      )
      if (!check.allowed) {
        return sendError(res, 404, 'Purchase plan not found')
      }
    }

    return res.json({ plan })
  }
)

router.patch(
  '/purchase-plans/:id',
  requireAuth,
  requireScope('fiat:write'),
  validate({
    params: fiatPurchasePlanIdParamSchema,
    body: updateFiatPurchasePlanSchema,
    errorMessage: 'Validation error',
  }),
  async (req: Request, res: Response) => {
    const actorUserId = req.auth?.userId ?? req.userId
    if (!actorUserId) {
      return sendError(res, 401, 'Unauthorized')
    }

    const existing = await (db as any).fiatPurchasePlan.findUnique({
      where: { id: req.params.id },
    })
    if (!existing) {
      return sendError(res, 404, 'Purchase plan not found')
    }

    const perm = await ensureSubAccountDepositPermission(
      actorUserId,
      existing.userId
    )
    if (!perm.allowed) {
      return res.status(403).json({
        error: 'Forbidden',
        required: 'DEPOSIT',
      })
    }

    if (existing.status === 'CANCELLED') {
      return sendError(res, 409, 'Cannot modify a cancelled purchase plan')
    }

    const data: Record<string, unknown> = { updatedAt: new Date() }
    if (req.body.fiatAmount !== undefined) data.fiatAmount = req.body.fiatAmount
    if (req.body.paymentMethodRef !== undefined) {
      data.paymentMethodRef = req.body.paymentMethodRef
    }
    if (req.body.cadence !== undefined) data.cadence = req.body.cadence
    if (req.body.status !== undefined) data.status = req.body.status
    if (req.body.autoDeposit !== undefined) {
      data.autoDeposit = req.body.autoDeposit
    }
    if (req.body.maxSlippagePct !== undefined) {
      data.maxSlippagePct = req.body.maxSlippagePct
    }
    if (req.body.baselineRate !== undefined) {
      data.baselineRate = req.body.baselineRate
    }
    if (req.body.retryPolicy !== undefined) {
      data.retryPolicy = req.body.retryPolicy
    }

    if (
      (req.body.status === 'ACTIVE' && existing.status === 'PAUSED') ||
      (req.body.cadence !== undefined && req.body.cadence !== existing.cadence)
    ) {
      const nextCadence = req.body.cadence ?? existing.cadence
      data.nextRunAt = calculateNextFiatPurchaseRun(nextCadence)
      if (req.body.status === 'ACTIVE') {
        data.consecutiveFailures = 0
        data.autoPauseReason = null
      }
    }

    const updated = await (db as any).fiatPurchasePlan.update({
      where: { id: existing.id },
      data,
    })

    const auditAction =
      req.body.status === 'PAUSED' && existing.status !== 'PAUSED'
        ? 'PLAN_PAUSED'
        : req.body.status === 'ACTIVE' && existing.status === 'PAUSED'
          ? 'PLAN_RESUMED'
          : req.body.status === 'CANCELLED'
            ? 'PLAN_CANCELLED'
            : 'PLAN_UPDATED'

    await recordPlanAuditEntry(db, auditAction, {
      planId: existing.id,
      actorUserId,
      before: {
        status: existing.status,
        fiatAmount: Number(existing.fiatAmount),
        cadence: existing.cadence,
        autoDeposit: existing.autoDeposit,
      },
      after: {
        status: updated.status,
        fiatAmount: Number(updated.fiatAmount),
        cadence: updated.cadence,
        autoDeposit: updated.autoDeposit,
      },
    })

    return res.json({ plan: updated })
  }
)

router.delete(
  '/purchase-plans/:id',
  requireAuth,
  requireScope('fiat:write'),
  validate({
    params: fiatPurchasePlanIdParamSchema,
    errorMessage: 'Validation error',
  }),
  async (req: Request, res: Response) => {
    const actorUserId = req.auth?.userId ?? req.userId
    if (!actorUserId) {
      return sendError(res, 401, 'Unauthorized')
    }

    const existing = await (db as any).fiatPurchasePlan.findUnique({
      where: { id: req.params.id },
    })
    if (!existing) {
      return sendError(res, 404, 'Purchase plan not found')
    }

    const perm = await ensureSubAccountDepositPermission(
      actorUserId,
      existing.userId
    )
    if (!perm.allowed) {
      return res.status(403).json({
        error: 'Forbidden',
        required: 'DEPOSIT',
      })
    }

    const updated = await (db as any).fiatPurchasePlan.update({
      where: { id: existing.id },
      data: {
        status: 'CANCELLED',
        updatedAt: new Date(),
      },
    })

    await recordPlanAuditEntry(db, 'PLAN_CANCELLED', {
      planId: existing.id,
      actorUserId,
      before: { status: existing.status },
      after: { status: 'CANCELLED' },
    })

    return res.json({ plan: updated })
  }
)

async function handlePurchasePlanPreview(req: Request, res: Response) {
  const actorUserId = req.auth?.userId ?? req.userId
  if (!actorUserId) {
    return sendError(res, 401, 'Unauthorized')
  }

  const plan = await (db as any).fiatPurchasePlan.findUnique({
    where: { id: req.params.id },
  })
  if (!plan) {
    return sendError(res, 404, 'Purchase plan not found')
  }
  if (plan.userId !== actorUserId) {
    const check = await checkSubAccountPermission(
      actorUserId,
      plan.userId,
      'VIEW'
    )
    if (!check.allowed) {
      return sendError(res, 404, 'Purchase plan not found')
    }
  }

  const runsCount = Number(req.query.runs ?? req.body?.runs ?? 6)
  try {
    let liveRate: number | null = null
    try {
      const quoteResult = await getBestExecutionQuote(
        {
          direction: 'ON_RAMP',
          fiatAmount: Number(plan.fiatAmount),
          fiatCurrency: plan.fiatCurrency,
          assetSymbol: plan.assetSymbol,
        },
        { userId: plan.userId },
        db
      )
      if (quoteResult.best) {
        liveRate =
          quoteResult.best.rate ??
          (Number(plan.fiatAmount) > 0
            ? Number(quoteResult.best.cryptoAmount) / Number(plan.fiatAmount)
            : null)
      }
    } catch {
      // Fallback to plan.baselineRate in generateFiatPurchasePreview
    }

    const preview = generateFiatPurchasePreview({
      plan,
      runs: Number.isFinite(runsCount) && runsCount > 0 ? runsCount : 6,
      liveRate,
    })
    return res.json(preview)
  } catch (err) {
    return respondToFiatError(res, err, 'Failed to generate purchase preview')
  }
}

router.get(
  '/purchase-plans/:id/preview',
  requireAuth,
  validate({
    params: fiatPurchasePlanIdParamSchema,
    query: fiatPurchasePlanPreviewQuerySchema,
    errorMessage: 'Validation error',
  }),
  handlePurchasePlanPreview
)

router.post(
  '/purchase-plans/:id/preview',
  requireAuth,
  validate({
    params: fiatPurchasePlanIdParamSchema,
    query: fiatPurchasePlanPreviewQuerySchema,
    errorMessage: 'Validation error',
  }),
  handlePurchasePlanPreview
)

router.get(
  '/purchase-plans/:id/runs',
  requireAuth,
  validate({
    params: fiatPurchasePlanIdParamSchema,
    query: fiatPurchasePlanRunsQuerySchema,
    errorMessage: 'Validation error',
  }),
  async (req: Request, res: Response) => {
    const actorUserId = req.auth?.userId ?? req.userId
    if (!actorUserId) {
      return sendError(res, 401, 'Unauthorized')
    }

    const plan = await (db as any).fiatPurchasePlan.findUnique({
      where: { id: req.params.id },
    })
    if (!plan) {
      return sendError(res, 404, 'Purchase plan not found')
    }
    if (plan.userId !== actorUserId) {
      const check = await checkSubAccountPermission(
        actorUserId,
        plan.userId,
        'VIEW'
      )
      if (!check.allowed) {
        return sendError(res, 404, 'Purchase plan not found')
      }
    }

    const page = Number(req.query.page ?? 1)
    const limit = Number(req.query.limit ?? 20)
    const skip = (page - 1) * limit

    const [runs, total] = await Promise.all([
      (db as any).fiatPurchasePlanRun.findMany({
        where: { planId: plan.id },
        orderBy: { scheduledFor: 'desc' },
        skip,
        take: limit,
      }),
      (db as any).fiatPurchasePlanRun.count({
        where: { planId: plan.id },
      }),
    ])

    return res.json({
      runs,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    })
  }
)

export default router
