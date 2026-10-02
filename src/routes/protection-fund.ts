/**
 * Protocol-Risk Protection Fund API (#533).
 *
 * Public status endpoint, per-user coverage view, and admin event declaration.
 */

import { Router, Request, Response } from 'express'
import { requireAuth } from '../middleware/authenticate'
import { requireAdminAuth } from '../middleware/adminAuth'
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
  declareEventSchema,
  eventIdParamSchema,
  reviewEventSchema,
} from '../validators/protection-fund-validators'

const router = Router()

// ── GET /protection-fund/status (public) ────────────────────────────────────
router.get('/status', async (_req: Request, res: Response) => {
  try {
    const status = await getProtectionFundStatus()
    return res.json(status)
  } catch (err) {
    logger.error('[ProtectionFund] Status query failed', { error: err instanceof Error ? err.message : String(err) })
    return sendError(res, 500, 'Failed to load protection fund status')
  }
})

// ── GET /protection-fund/my-coverage ────────────────────────────────────────
router.get('/my-coverage', requireAuth, async (req: Request, res: Response) => {
  try {
    const coverage = await getMyCoverage(req.auth!.userId)
    return res.json(coverage)
  } catch (err) {
    logger.error('[ProtectionFund] My-coverage query failed', { error: err instanceof Error ? err.message : String(err) })
    return sendError(res, 500, 'Failed to load coverage')
  }
})

// ── POST /protection-fund/events (admin, dual-review) ───────────────────────
router.post(
  '/events',
  requireAuth,
  requireAdminAuth,
  idempotent({ required: true, failClosed: true, ttlSeconds: 86400 }),
  validate({ body: declareEventSchema, errorMessage: 'Validation error' }),
  async (req: Request, res: Response) => {
    try {
      const event = await declareCoverageEvent({
        ...req.body,
        declaredBy: req.auth!.userId,
      })
      return res.status(201).json({
        eventId: event.id,
        status: event.status,
        message: 'Coverage event declared and pending review',
      })
    } catch (err) {
      if (err instanceof Error && err.message.includes('not a covered event type')) {
        return sendError(res, 400, err.message)
      }
      logger.error('[ProtectionFund] Declare event failed', { error: err instanceof Error ? err.message : String(err) })
      return sendError(res, 500, 'Failed to declare coverage event')
    }
  }
)

// ── POST /protection-fund/events/:eventId/review (admin) ───────────────────
router.post(
  '/events/:eventId/review',
  requireAuth,
  requireAdminAuth,
  idempotent({ required: true, failClosed: true, ttlSeconds: 86400 }),
  validate({ params: eventIdParamSchema, errorMessage: 'Invalid event ID' }),
  validate({ body: reviewEventSchema, errorMessage: 'Validation error' }),
  async (req: Request, res: Response) => {
    try {
      const { eventId } = req.params as unknown as { eventId: string }
      const { approved } = req.body as { approved: boolean }
      const event = await reviewCoverageEvent(eventId, approved, req.auth!.userId)
      return res.json({
        eventId: event.id,
        status: event.status,
        message: approved ? 'Event approved, claims computed' : 'Event rejected',
      })
    } catch (err) {
      if (err instanceof Error && err.message === 'Coverage event not found') {
        return sendNotFound(res, 'Coverage event not found')
      }
      if (err instanceof Error && err.message.includes('not pending review')) {
        return sendError(res, 409, err.message)
      }
      logger.error('[ProtectionFund] Review event failed', { error: err instanceof Error ? err.message : String(err) })
      return sendError(res, 500, 'Failed to review event')
    }
  }
)

// ── POST /protection-fund/contributions (admin) ─────────────────────────────
router.post(
  '/contributions',
  requireAuth,
  requireAdminAuth,
  idempotent({ required: true, failClosed: true, ttlSeconds: 86400 }),
  async (req: Request, res: Response) => {
    try {
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
        createdBy: req.auth!.userId,
      })
      return res.status(201).json({
        contributionId: contribution.id,
        amount: Number(contribution.amount),
        assetSymbol: contribution.assetSymbol,
      })
    } catch (err) {
      logger.error('[ProtectionFund] Record contribution failed', { error: err instanceof Error ? err.message : String(err) })
      return sendError(res, 500, 'Failed to record contribution')
    }
  }
)

// ── POST /protection-fund/claims/:claimId/payout (admin) ───────────────────
router.post(
  '/claims/:claimId/payout',
  requireAuth,
  requireAdminAuth,
  idempotent({ required: true, failClosed: true, ttlSeconds: 86400 }),
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
      logger.error('[ProtectionFund] Payout failed', { error: err instanceof Error ? err.message : String(err) })
      return sendError(res, 500, 'Failed to execute payout')
    }
  }
)

export default router
