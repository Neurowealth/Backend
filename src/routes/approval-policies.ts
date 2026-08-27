import { Router, Request, Response } from 'express'
import { requireAuth } from '../middleware/authenticate'
import { validate } from '../middleware/validate'
import { sendError, sendNotFound } from '../utils/errors'
import { logger } from '../utils/logger'
import db from '../db'
import {
  createApprovalPolicySchema,
  updateApprovalPolicySchema,
} from '../validators/approval-validators'

const router = Router()

/**
 * A policy scoped to a child (scopedToChildUserId set) governs a
 * sub-account relationship, so creating/editing it requires the caller to
 * currently hold MANAGE_STRATEGY on that child — the same authority level
 * the issue assigns to sub-account policy changes. Re-checked on every
 * write (not just at creation) since the underlying SubAccount grant can be
 * revoked or narrowed later.
 */
async function assertManageStrategyOnChild(
  parentUserId: string,
  childUserId: string,
  res: Response
): Promise<boolean> {
  const subAccount = await db.subAccount.findUnique({
    where: {
      parentUserId_childUserId: { parentUserId, childUserId },
    },
  })
  if (
    !subAccount ||
    subAccount.status !== 'ACTIVE' ||
    !subAccount.permissions.includes('MANAGE_STRATEGY')
  ) {
    sendError(res, 403, 'Forbidden', { required: 'MANAGE_STRATEGY' })
    return false
  }
  return true
}

// ── GET / — policies the caller owns (own-account + any child-scoped) ──────
router.get('/', requireAuth, async (req: Request, res: Response) => {
  const policies = await db.approvalPolicy.findMany({
    where: { principalUserId: req.auth!.userId },
    orderBy: { createdAt: 'desc' },
  })
  res.json({ policies })
})

// ── GET /:id ─────────────────────────────────────────────────────────────
router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  const policy = await db.approvalPolicy.findUnique({
    where: { id: req.params.id },
  })
  if (!policy || policy.principalUserId !== req.auth!.userId) {
    return sendNotFound(res, 'Approval policy')
  }
  res.json({ policy })
})

// ── POST / — create a policy ────────────────────────────────────────────────
router.post(
  '/',
  requireAuth,
  validate({
    body: createApprovalPolicySchema,
    errorMessage: 'Validation error',
  }),
  async (req: Request, res: Response) => {
    const principalUserId = req.auth!.userId
    const {
      scopedToChildUserId,
      permission,
      minApprovers,
      highValueThreshold,
      approvalTimeoutMs,
    } = req.body

    if (scopedToChildUserId) {
      const ok = await assertManageStrategyOnChild(
        principalUserId,
        scopedToChildUserId,
        res
      )
      if (!ok) return
    }

    const policy = await db.approvalPolicy.create({
      data: {
        principalUserId,
        scopedToChildUserId: scopedToChildUserId ?? null,
        permission,
        minApprovers,
        highValueThreshold: highValueThreshold ?? null,
        approvalTimeoutMs,
      },
    })

    logger.info('[ApprovalPolicy] Created', {
      principalUserId,
      scopedToChildUserId,
      permission,
      minApprovers,
    })

    res.status(201).json({ policy })
  }
)

// ── PUT /:id — update a policy ──────────────────────────────────────────────
router.put(
  '/:id',
  requireAuth,
  validate({
    body: updateApprovalPolicySchema,
    errorMessage: 'Validation error',
  }),
  async (req: Request, res: Response) => {
    const principalUserId = req.auth!.userId
    const policy = await db.approvalPolicy.findUnique({
      where: { id: req.params.id },
    })
    if (!policy) return sendNotFound(res, 'Approval policy')
    if (policy.principalUserId !== principalUserId) {
      return sendError(res, 403, 'Forbidden')
    }

    if (policy.scopedToChildUserId) {
      const ok = await assertManageStrategyOnChild(
        principalUserId,
        policy.scopedToChildUserId,
        res
      )
      if (!ok) return
    }

    const { minApprovers, highValueThreshold, approvalTimeoutMs, isActive } =
      req.body

    const updated = await db.approvalPolicy.update({
      where: { id: req.params.id },
      data: {
        ...(minApprovers !== undefined && { minApprovers }),
        ...(highValueThreshold !== undefined && { highValueThreshold }),
        ...(approvalTimeoutMs !== undefined && { approvalTimeoutMs }),
        ...(isActive !== undefined && { isActive }),
      },
    })

    logger.info('[ApprovalPolicy] Updated', {
      id: req.params.id,
      principalUserId,
    })

    res.json({ policy: updated })
  }
)

export default router
