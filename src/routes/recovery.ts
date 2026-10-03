/**
 * Guardian-Based Social Recovery API (#535).
 *
 * Two groups of endpoints, and the split between them is the security model:
 *
 * - OWNER endpoints (requireAuth): manage the guardian set, read your own
 *   request, and cancel it. Every one of them keys off `req.auth.userId` from
 *   the caller's own session and never from a body or path field, so there is
 *   no id-oracle anywhere in this file.
 *
 * - PUBLIC endpoints (no auth): the "I cannot get in" door, and the token-gated
 *   accept/approve flows for guardians. These are the only endpoints reachable
 *   by somebody who has lost their account, which is exactly why they are the
 *   ones that must not leak whether a wallet exists.
 *
 * There is deliberately NO route that executes a recovery. Execution is
 * platform-side only (src/jobs/guardianRecoverySweep.ts): a route would be
 * reachable only by an authenticated user of the account being recovered, and
 * the moment it succeeded every one of their sessions would be revoked, so
 * nobody could ever call it.
 */
import { Router, Request, Response } from 'express'
import { requireAuth } from '../middleware/authenticate'
import { validate } from '../middleware/validate'
import { recoveryRateLimiter } from '../middleware/rateLimiter'
import { sendError } from '../utils/errors'
import { logger } from '../utils/logger'
import {
  acceptGuardianInviteAsUser,
  approveRecoveryAsExternalGuardian,
  approveRecoveryAsGuardian,
  cancelRecovery,
  getOrCreateRecoveryPolicy,
  getRecoveryRequestForOwner,
  initiateRecovery,
  listGuardians,
  listRequestsAwaitingGuardian,
  nominateGuardian,
  removeGuardian,
  respondToGuardianInvite,
  toRecoveryError,
  updateRecoveryPolicy,
} from '../guardians/service'
import {
  approveRecoverySchema,
  externalApprovalSchema,
  guardianIdParamSchema,
  initiateRecoverySchema,
  nominateGuardianSchema,
  recoveryRequestIdParamSchema,
  respondToGuardianInviteSchema,
  updateRecoveryPolicySchema,
} from '../validators/recovery-validators'

const router = Router()

/**
 * A single place that turns anything thrown by the service into a response, so
 * a `RecoveryError` keeps its own status and code while an unexpected throw
 * still becomes a clean 500 instead of leaking a stack trace.
 */
function handleError(res: Response, err: unknown, context: string): Response {
  const recoveryError = toRecoveryError(err)

  if (recoveryError.status >= 500) {
    logger.error(`[Recovery] ${context} failed`, {
      error: recoveryError.message,
      code: recoveryError.code,
    })
    return sendError(res, 500, 'Something went wrong. Please try again.')
  }

  return sendError(res, recoveryError.status, recoveryError.message, {
    code: recoveryError.code,
  })
}

// ─── Owner: recovery policy ──────────────────────────────────────────────────

router.get('/policy', requireAuth, async (req: Request, res: Response) => {
  try {
    const policy = await getOrCreateRecoveryPolicy(req.auth!.userId)
    return res.json({ policy })
  } catch (err) {
    return handleError(res, err, 'Get policy')
  }
})

router.put(
  '/policy',
  requireAuth,
  validate({ body: updateRecoveryPolicySchema }),
  async (req: Request, res: Response) => {
    try {
      const policy = await updateRecoveryPolicy(req.auth!.userId, req.body)
      return res.json({ policy })
    } catch (err) {
      return handleError(res, err, 'Update policy')
    }
  }
)

// ─── Owner: guardian set ─────────────────────────────────────────────────────

router.get('/guardians', requireAuth, async (req: Request, res: Response) => {
  try {
    const guardians = await listGuardians(req.auth!.userId)
    return res.json({ guardians, count: guardians.length })
  } catch (err) {
    return handleError(res, err, 'List guardians')
  }
})

/**
 * Nominating a guardian. The invite token is returned ONCE, in this response,
 * and only its digest is stored — the caller is responsible for delivering it.
 * The service also sends the invitation out of band.
 */
router.post(
  '/guardians',
  requireAuth,
  validate({ body: nominateGuardianSchema }),
  async (req: Request, res: Response) => {
    try {
      const result = await nominateGuardian({
        userId: req.auth!.userId,
        guardianUserId: req.body.guardianUserId,
        externalEmail: req.body.externalEmail,
        externalPhone: req.body.externalPhone,
      })
      return res.status(201).json(result)
    } catch (err) {
      return handleError(res, err, 'Nominate guardian')
    }
  }
)

/** Removal is immediate and does not need the other guardians or a quorum. */
router.delete(
  '/guardians/:guardianId',
  requireAuth,
  validate({ params: guardianIdParamSchema }),
  async (req: Request, res: Response) => {
    try {
      const guardian = await removeGuardian({
        userId: req.auth!.userId,
        guardianId: req.params.guardianId,
      })
      return res.json({ guardian })
    } catch (err) {
      return handleError(res, err, 'Remove guardian')
    }
  }
)

/**
 * A PLATFORM guardian accepting their nomination. Unauthenticated in spirit
 * but authenticated in fact: the service re-checks that the session's user is
 * the nominated guardian, so `requireAuth` is necessary but not sufficient.
 */
router.post(
  '/guardians/:guardianId/accept',
  requireAuth,
  validate({ params: guardianIdParamSchema }),
  async (req: Request, res: Response) => {
    try {
      const guardian = await acceptGuardianInviteAsUser({
        guardianId: req.params.guardianId,
        actorUserId: req.auth!.userId,
      })
      return res.json({ guardian })
    } catch (err) {
      return handleError(res, err, 'Accept guardian invitation')
    }
  }
)

/** An EXTERNAL contact accepting, or declining, with the token they were sent. */
router.post(
  '/invitations/respond',
  recoveryRateLimiter,
  validate({ body: respondToGuardianInviteSchema }),
  async (req: Request, res: Response) => {
    try {
      const guardian = await respondToGuardianInvite({
        token: req.body.token,
        accept: req.body.accept,
      })
      return res.json({ guardian })
    } catch (err) {
      return handleError(res, err, 'Respond to guardian invitation')
    }
  }
)

// ─── Owner: the request itself ───────────────────────────────────────────────

/**
 * PUBLIC and rate limited, because it is the only way in for a locked-out
 * owner. It deliberately answers 202 with a fixed body in EVERY case — account
 * found or not, primary or sub-account, guardians configured or not, a request
 * already open or not. Any variation at all turns this into a wallet-existence
 * and wallet-sub-account oracle, which is worth more to an attacker than the
 * recovery itself. The owner learns the outcome from the loud alert instead.
 */
router.post(
  '/initiate',
  recoveryRateLimiter,
  validate({ body: initiateRecoverySchema }),
  async (req: Request, res: Response) => {
    try {
      await initiateRecovery({
        walletAddress: req.body.walletAddress,
        reason: req.body.reason,
      })
    } catch (err) {
      // A genuine fault still must not distinguish itself: log loudly, answer
      // with the same generic body the success path returns.
      logger.error('[Recovery] Initiate recovery failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }

    return res.status(202).json({
      status: 'accepted',
      message:
        'If an eligible primary account matches that wallet address, its accepted guardians have been contacted and the account owner has been alerted.',
    })
  }
)

/** Owner-only. Reads the caller's own request; the id is not an oracle. */
router.get(
  '/requests/:requestId',
  requireAuth,
  validate({ params: recoveryRequestIdParamSchema }),
  async (req: Request, res: Response) => {
    try {
      const request = await getRecoveryRequestForOwner({
        requestId: req.params.requestId,
        userId: req.auth!.userId,
      })
      return res.json({ request })
    } catch (err) {
      return handleError(res, err, 'Get recovery request')
    }
  }
)

/**
 * Owner cancels their own request: immediate, unilateral, no quorum. Permitted
 * at any point before execution wins the race, including after quorum.
 */
router.post(
  '/requests/:requestId/cancel',
  requireAuth,
  validate({ params: recoveryRequestIdParamSchema }),
  async (req: Request, res: Response) => {
    try {
      const request = await cancelRecovery({
        requestId: req.params.requestId,
        userId: req.auth!.userId,
      })
      return res.json({ request })
    } catch (err) {
      return handleError(res, err, 'Cancel recovery')
    }
  }
)

// ─── Guardian: decisions ─────────────────────────────────────────────────────

/** Requests this platform user has been asked to decide on. */
router.get(
  '/guardian/requests',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const requests = await listRequestsAwaitingGuardian(req.auth!.userId)
      return res.json({ requests, count: requests.length })
    } catch (err) {
      return handleError(res, err, 'List guardian requests')
    }
  }
)

/**
 * A platform guardian deciding, proven by their own session. The service
 * re-checks the nomination, so this cannot be used to decide for somebody
 * else's account.
 */
router.post(
  '/guardian/requests/:requestId/decide',
  requireAuth,
  validate({
    params: recoveryRequestIdParamSchema,
    body: approveRecoverySchema,
  }),
  async (req: Request, res: Response) => {
    try {
      const request = await approveRecoveryAsGuardian({
        requestId: req.params.requestId,
        actorUserId: req.auth!.userId,
        approved: req.body.approved,
        note: req.body.note,
        ipAddress: req.ip,
      })
      return res.json({ request })
    } catch (err) {
      return handleError(res, err, 'Guardian decision')
    }
  }
)

/**
 * An EXTERNAL contact deciding, proven only by the token in their link. The
 * token identifies WHICH guardian is deciding, so one guardian can never decide
 * on another's behalf, and the one-decision-per-(request, guardian) row stops a
 * replayed token from producing a second vote.
 */
router.post(
  '/guardian/decide',
  recoveryRateLimiter,
  validate({ body: externalApprovalSchema }),
  async (req: Request, res: Response) => {
    try {
      const request = await approveRecoveryAsExternalGuardian({
        requestId: req.body.requestId,
        token: req.body.token,
        approved: req.body.approved,
        note: req.body.note,
        ipAddress: req.ip,
      })
      return res.json({ request })
    } catch (err) {
      return handleError(res, err, 'External guardian decision')
    }
  }
)

export default router
