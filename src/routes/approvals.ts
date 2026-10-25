import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { paginationSchema } from '../utils/pagination'
import { requireAuth } from '../middleware/authenticate'
import { validate } from '../middleware/validate'
import { idempotent } from '../middleware/idempotency'
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

const approvalListQuerySchema = paginationSchema.extend({
  status: z
    .enum([
      'PENDING',
      'APPROVED',
      'EXECUTED',
      'REJECTED',
      'EXPIRED',
      'CANCELLED',
    ])
    .optional(),
  sortBy: z.enum(['requestedAt', 'executedAt']).default('requestedAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
})

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
router.get(
  '/',
  requireAuth,
  validate({ query: approvalListQuerySchema }),
  async (req: Request, res: Response) => {
    try {
      const query = req.query as unknown as z.infer<
        typeof approvalListQuerySchema
      >
      const result = await listApprovalRequestsForUser(req.auth!.userId, {
        page: query.page,
        limit: query.limit,
        status: query.status,
        sortBy: query.sortBy,
        sortOrder: query.sortOrder,
      })
      res.json(result)
    } catch (err) {
      handleServiceError(res, err, 'List')
    }
  }
)

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
  idempotent({ required: false, ttlSeconds: 86400 }),
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
  idempotent({ required: false, ttlSeconds: 86400 }),
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
router.post(
  '/:id/cancel',
  requireAuth,
  idempotent({ required: false, ttlSeconds: 86400 }),
  async (req: Request, res: Response) => {
    try {
      const result = await cancel(req.params.id, req.auth!.userId)
      res.json(result)
    } catch (err) {
      handleServiceError(res, err, 'Cancel')
    }
  }
)

export default router
