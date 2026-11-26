import { NextFunction, Response, Router } from 'express'
import { z } from 'zod'
import { requireAuth } from '../middleware/authenticate'
import { requireSessionAuth } from '../middleware/apiKeyAuth'
import { requireNotImpersonation } from '../middleware/impersonation'
import { validate } from '../middleware/validate'
import {
  acceptGuardianInvitation,
  approveRecovery,
  cancelRecovery,
  cancelRecoveryWithEmailToken,
  configureRecovery,
  getRecoveryRequest,
  initiateRecovery,
  listRecoveryGuardians,
  RecoveryError,
} from '../recovery/service'

const router = Router()
const paramsSchema = z.object({ id: z.string().uuid() })
const guardianSetupSchema = z.object({
  guardianUserIds: z.array(z.string().uuid()).min(3).max(5),
  requiredApprovals: z.number().int().min(2).max(5),
})
const initiateSchema = z.object({
  currentWalletAddress: z.string().min(1),
  newWalletAddress: z.string().min(1),
})
const emailCancelSchema = z.object({
  token: z.string().min(32).max(128),
})

function sendRecoveryError(
  res: Response,
  next: NextFunction,
  error: unknown
): void {
  if (error instanceof RecoveryError) {
    res.status(error.statusCode).json({ error: error.message })
    return
  }
  next(error)
}

router.get(
  '/guardians',
  requireAuth,
  requireSessionAuth,
  requireNotImpersonation,
  async (req, res, next) => {
    try {
      res.json(await listRecoveryGuardians(req.auth!.userId))
    } catch (error) {
      next(error)
    }
  }
)

router.get(
  '/:id',
  requireAuth,
  requireSessionAuth,
  requireNotImpersonation,
  validate({ params: paramsSchema }),
  async (req, res, next) => {
    try {
      res.json(await getRecoveryRequest(req.auth!.userId, req.params.id))
    } catch (error) {
      sendRecoveryError(res, next, error)
    }
  }
)

router.post(
  '/guardians',
  requireAuth,
  requireSessionAuth,
  requireNotImpersonation,
  validate({ body: guardianSetupSchema }),
  async (req, res, next) => {
    try {
      await configureRecovery(
        req.auth!.userId,
        req.body.guardianUserIds,
        req.body.requiredApprovals
      )
      res.status(201).json({
        status: 'pending_guardian_acceptance',
        recoveryDelayHours: 72,
      })
    } catch (error) {
      sendRecoveryError(res, next, error)
    }
  }
)

router.post(
  '/guardians/:id/accept',
  requireAuth,
  requireSessionAuth,
  requireNotImpersonation,
  validate({ params: paramsSchema }),
  async (req, res, next) => {
    try {
      const accepted = await acceptGuardianInvitation(
        req.auth!.userId,
        req.params.id
      )
      if (!accepted) {
        res.status(404).json({ error: 'Guardian invitation not found' })
        return
      }
      res.json({ status: 'accepted' })
    } catch (error) {
      next(error)
    }
  }
)

router.post(
  '/initiate',
  validate({ body: initiateSchema }),
  async (req, res, next) => {
    try {
      const request = await initiateRecovery(
        req.body.currentWalletAddress,
        req.body.newWalletAddress
      )
      res.status(202).json({
        requestId: request.id,
        status: 'PENDING',
        recoveryDelayHours: 72,
      })
    } catch (error) {
      sendRecoveryError(res, next, error)
    }
  }
)

router.post(
  '/:id/approve',
  requireAuth,
  requireSessionAuth,
  requireNotImpersonation,
  validate({ params: paramsSchema }),
  async (req, res, next) => {
    try {
      const result = await approveRecovery(req.auth!.userId, req.params.id)
      res.json({
        status: result.completesAt ? 'COOLING_OFF' : 'PENDING',
        approvedCount: result.approvedCount,
        requiredApprovals: result.requiredApprovals,
        completesAt: result.completesAt?.toISOString() ?? null,
      })
    } catch (error) {
      sendRecoveryError(res, next, error)
    }
  }
)

router.post(
  '/:id/cancel',
  requireAuth,
  requireSessionAuth,
  requireNotImpersonation,
  validate({ params: paramsSchema }),
  async (req, res, next) => {
    try {
      const cancelled = await cancelRecovery(req.auth!.userId, req.params.id)
      if (!cancelled) {
        res.status(404).json({ error: 'Active recovery request not found' })
        return
      }
      res.json({ status: 'CANCELLED' })
    } catch (error) {
      next(error)
    }
  }
)

router.post(
  '/:id/cancel-email',
  validate({ params: paramsSchema, body: emailCancelSchema }),
  async (req, res, next) => {
    try {
      const cancelled = await cancelRecoveryWithEmailToken(
        req.params.id,
        req.body.token
      )
      if (!cancelled) {
        res.status(404).json({ error: 'Active recovery request not found' })
        return
      }
      res.json({ status: 'CANCELLED' })
    } catch (error) {
      next(error)
    }
  }
)

export default router
