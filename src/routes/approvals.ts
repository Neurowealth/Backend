import { Router, Request, Response } from 'express'
import { requireAuth } from '../middleware/authenticate'
import { validate } from '../middleware/validate'
import { sendError, sendNotFound, AppError } from '../utils/errors'
import { logger } from '../utils/logger'
import { approveSchema, rejectSchema } from '../validators/approval-validators'
import {
  decide,
  cancel,
  listApprovalRequestsForUser,
  getVisibleRequestDetail,
} from '../approvals/service'

const router = Router()

function handleServiceError(res: Response, err: unknown, action: string) {
  if (err instanceof AppError) {
    return sendError(res, err.statusCode, err.message)
  }
  logger.error(`[Approvals] ${action} failed`, {
    error: err instanceof Error ? err.message : String(err),
  })
  return sendError(res, 500, 'Internal server error')
}

// ── GET / — requests affecting the caller (as principal or eligible approver) ──
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const result = await listApprovalRequestsForUser(req.auth!.userId, {
      page: req.query.page,
      limit: req.query.limit,
    })
    res.json(result)
  } catch (err) {
    handleServiceError(res, err, 'List')
  }
})

// ── GET /:id — full request + decisions ─────────────────────────────────────
router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const request = await getVisibleRequestDetail(
      req.params.id,
      req.auth!.userId
    )
    if (!request) {
      return sendNotFound(res, 'Approval request')
    }
    res.json({ request })
  } catch (err) {
    handleServiceError(res, err, 'Get')
  }
})

// ── POST /:id/approve ────────────────────────────────────────────────────────
router.post(
  '/:id/approve',
  requireAuth,
  validate({ body: approveSchema, errorMessage: 'Validation error' }),
  async (req: Request, res: Response) => {
    try {
      const result = await decide(
        req.params.id,
        req.auth!.userId,
        true,
        req.body.note
      )
      res.json(result)
    } catch (err) {
      handleServiceError(res, err, 'Approve')
    }
  }
)

// ── POST /:id/reject ─────────────────────────────────────────────────────────
router.post(
  '/:id/reject',
  requireAuth,
  validate({ body: rejectSchema, errorMessage: 'Validation error' }),
  async (req: Request, res: Response) => {
    try {
      const result = await decide(
        req.params.id,
        req.auth!.userId,
        false,
        req.body.reason
      )
      res.json(result)
    } catch (err) {
      handleServiceError(res, err, 'Reject')
    }
  }
)

// ── POST /:id/cancel — requester (admin cancellation: see routes/admin.ts) ──
router.post('/:id/cancel', requireAuth, async (req: Request, res: Response) => {
  try {
    const result = await cancel(req.params.id, req.auth!.userId)
    res.json(result)
  } catch (err) {
    handleServiceError(res, err, 'Cancel')
  }
})

export default router
