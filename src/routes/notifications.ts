import { Router, Request, Response } from 'express'
import { requireAuth } from '../middleware/authenticate'
import { requireNotImpersonation } from '../middleware/impersonation'
import {
  registerPushDevice,
  deregisterPushDevice,
} from '../controllers/push-controller'
import {
  requestEmailVerification,
  verifyEmail,
} from '../controllers/email-identity-controller'
import digestsRouter from './digests'

const router = Router()

// Push device tokens (#547, #762)
router.post(
  '/push/devices',
  requireAuth,
  requireNotImpersonation,
  async (req: Request, res: Response) => {
    const userId = req.auth!.userId
    const result = await registerPushDevice(userId, req.body)
    if (!result.success) {
      return res.status(400).json({ error: result.error })
    }
    return res.status(200).json(result)
  }
)

router.delete(
  '/push/devices/:token',
  requireAuth,
  requireNotImpersonation,
  async (req: Request, res: Response) => {
    const userId = req.auth!.userId
    const token = req.params.token
    const result = await deregisterPushDevice(userId, token)
    if (!result.success) {
      const status = result.error === 'Device token not found' ? 404 : 400
      return res.status(status).json({ error: result.error })
    }
    return res.status(200).json(result)
  }
)

router.delete(
  '/push/devices',
  requireAuth,
  requireNotImpersonation,
  async (req: Request, res: Response) => {
    const userId = req.auth!.userId
    const token = (req.body?.token || req.query?.token) as string
    if (!token) {
      return res.status(400).json({ error: 'Device token required' })
    }
    const result = await deregisterPushDevice(userId, token)
    if (!result.success) {
      const status = result.error === 'Device token not found' ? 404 : 400
      return res.status(status).json({ error: result.error })
    }
    return res.status(200).json(result)
  }
)

// Email verification opt-in endpoints (#367)
router.post(
  '/email',
  requireAuth,
  requireNotImpersonation,
  requestEmailVerification
)
router.get('/email/verify', verifyEmail)

// Cross-channel digest subscriptions (#365)
router.use('/digests', digestsRouter)

export default router
