/**
 * Protocol-Risk Protection Fund API (#533).
 *
 * Public status endpoint, per-user coverage view, and admin event declaration.
 *
 * #758 — the four admin POST routes used to chain `requireAuth` then
 * `requireAdminAuth`. Both read the same `Authorization: Bearer` header, so
 * `requireAuth` demanded a user JWT while `requireAdminAuth` then bcrypt-
 * checked that same JWT as an admin key and always returned 403. The admin
 * routes now use admin identity only (`getAdminAuth(res).id`), guarded by
 * the `protection-fund:write` scope, and the router is mounted behind
 * `adminRateLimiter` in `src/routes/registry.ts`. `getTokenFromRequest`
 * Bearer-first behaviour is unchanged: with no user JWT in play, Bearer
 * now carries the admin key, which is the correct token here.
 */

import { Router, Request, Response } from 'express'
import { requireAuth } from '../middleware/authenticate'
import {
  getAdminAuth,
  requireAdminAuth,
  requireAdminScope,
} from '../middleware/adminAuth'
import { validate } from '../middleware/validate'
import { idempotent } from '../middleware/idempotency'
import { sendError, sendNotFound } from '../utils/errors'
import { logger } from '../utils/logger'
import {
  declareCoverageEvent,
  executePayout,
  getMyCoverage,
  getProtectionFundStatus,
  recordContribution,
  reviewCoverageEvent,
} from '../protectionFund/service'
import {
  claimIdParamSchema,
  declareEventSchema,
  eventIdParamSchema,
  recordContributionSchema,
  reviewEventSchema,
} from '../validators/protection-fund-validators'

const router = Router()

/**
 * The admin key id for this request, or undefined when admin auth is
 * missing. `requireAdminAuth` + `requireAdminScope` run before every
 * handler that uses this, so a missing id here is a defence-in-depth 401.
 */
function adminId(res: Response): string | undefined {
  return getAdminAuth(res)?.id
}

// ── GET /protection-fund/status (public) ────────────────────────────────────
router.get('/status', async (_req: Request, res: Response) => {
  try {
    const status = await getProtectionFundStatus()
    return res.json(status)
  } catch (err) {
    logger.error('[ProtectionFund] Status query failed', {
      error: err instanceof Error ? err.message : String(err),
    })
    return sendError(res, 500, 'Failed to load protection fund status')
  }
})

// ── GET /protection-fund/my-coverage ────────────────────────────────────────
router.get('/my-coverage', requireAuth, async (req: Request, res: Response) => {
  try {
    const coverage = await getMyCoverage(req.auth!.userId)
    return res.json(coverage)
  } catch (err) {
    logger.error('[ProtectionFund] My-coverage query failed', {
      error: err instanceof Error ? err.message : String(err),
    })
    return sendError(res, 500, 'Failed to load coverage')
  }
})

// ── POST /protection-fund/events (admin, dual-review) ───────────────────────
router.post(
  '/events',
  requireAdminAuth,
  requireAdminScope('protection-fund:write'),
  idempotent({ required: true, failClosed: true, ttlSeconds: 86400 }),
  validate({ body: declareEventSchema, errorMessage: 'Validation error' }),
  async (req: Request, res: Response) => {
    try {
      const declaredBy = adminId(res)
      if (!declaredBy) {
        return sendError(res, 401, 'Admin authentication required')
      }
      const event = await declareCoverageEvent({
        ...req.body,
        declaredBy,
      })
      return res.status(201).json({
        eventId: event.id,
        status: event.status,
        message: 'Coverage event declared and pending review',
      })
    } catch (err) {
      if (
        err instanceof Error &&
        err.message.includes('not a covered event type')
      ) {
        return sendError(res, 400, err.message)
      }
      logger.error('[ProtectionFund] Declare event failed', {
        error: err instanceof Error ? err.message : String(err),
      })
      return sendError(res, 500, 'Failed to declare coverage event')
    }
  }
)

// ── POST /protection-fund/events/:eventId/review (admin) ───────────────────
router.post(
  '/events/:eventId/review',
  requireAdminAuth,
  requireAdminScope('protection-fund:write'),
  idempotent({ required: true, failClosed: true, ttlSeconds: 86400 }),
  validate({ params: eventIdParamSchema, errorMessage: 'Invalid event ID' }),
  validate({ body: reviewEventSchema, errorMessage: 'Validation error' }),
  async (req: Request, res: Response) => {
    try {
      const reviewedBy = adminId(res)
      if (!reviewedBy) {
        return sendError(res, 401, 'Admin authentication required')
      }
      const { eventId } = req.params as unknown as { eventId: string }
      const { approved } = req.body as { approved: boolean }
      const event = await reviewCoverageEvent(eventId, approved, reviewedBy)
      return res.json({
        eventId: event.id,
        status: event.status,
        message: approved
          ? 'Event approved, claims computed'
          : 'Event rejected',
      })
    } catch (err) {
      if (err instanceof Error && err.message === 'Coverage event not found') {
        return sendNotFound(res, 'Coverage event not found')
      }
      if (err instanceof Error && err.message.includes('not pending review')) {
        return sendError(res, 409, err.message)
      }
      // #758 — dual-review: the admin who declared the event cannot
      // review it. The service rejects this; the route maps it to 403.
      if (
        err instanceof Error &&
        err.message.includes('different admin than the declarer')
      ) {
        return sendError(res, 403, err.message)
      }
      logger.error('[ProtectionFund] Review event failed', {
        error: err instanceof Error ? err.message : String(err),
      })
      return sendError(res, 500, 'Failed to review event')
    }
  }
)

// ── POST /protection-fund/contributions (admin) ─────────────────────────────
router.post(
  '/contributions',
  requireAdminAuth,
  requireAdminScope('protection-fund:write'),
  idempotent({ required: true, failClosed: true, ttlSeconds: 86400 }),
  validate({
    body: recordContributionSchema,
    errorMessage: 'Validation error',
  }),
  async (req: Request, res: Response) => {
    try {
      const createdBy = adminId(res)
      if (!createdBy) {
        return sendError(res, 401, 'Admin authentication required')
      }
      const { source, assetSymbol, amount, sourceRef } = req.body as {
        source: string
        assetSymbol: string
        amount: number
        sourceRef?: string
      }
      const contribution = await recordContribution({
        source,
        assetSymbol,
        amount,
        sourceRef,
        createdBy,
      })
      return res.status(201).json({
        contributionId: contribution.id,
        amount: contribution.amount.toString(),
        assetSymbol: contribution.assetSymbol,
      })
    } catch (err) {
      logger.error('[ProtectionFund] Record contribution failed', {
        error: err instanceof Error ? err.message : String(err),
      })
      return sendError(res, 500, 'Failed to record contribution')
    }
  }
)

// ── POST /protection-fund/claims/:claimId/payout (admin) ───────────────────
router.post(
  '/claims/:claimId/payout',
  requireAdminAuth,
  requireAdminScope('protection-fund:write'),
  idempotent({ required: true, failClosed: true, ttlSeconds: 86400 }),
  validate({ params: claimIdParamSchema, errorMessage: 'Invalid claim ID' }),
  async (req: Request, res: Response) => {
    try {
      const { claimId } = req.params as unknown as { claimId: string }
      const outboxOp = await executePayout(claimId)
      return res.json({
        claimId,
        outboxOpId: outboxOp.id,
        status: 'PAYOUT_QUEUED',
      })
    } catch (err) {
      if (err instanceof Error && err.message === 'Claim not found') {
        return sendNotFound(res, 'Claim not found')
      }
      logger.error('[ProtectionFund] Payout failed', {
        error: err instanceof Error ? err.message : String(err),
      })
      return sendError(res, 500, 'Failed to execute payout')
    }
  }
)

export default router
