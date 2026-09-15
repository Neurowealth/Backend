import { Router } from 'express'
import { requireAuth } from '../middleware/authenticate'
import {
  requestEmailVerification,
  verifyEmail,
} from '../controllers/email-identity-controller'
import digestsRouter from './digests'

const router = Router()

// Email verification opt-in endpoints (#367)
router.post('/email', requireAuth, requestEmailVerification)
router.get('/email/verify', verifyEmail)

// Cross-channel digest subscriptions (#365)
router.use('/digests', digestsRouter)

export default router
