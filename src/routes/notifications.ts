import { Router } from 'express'
import { requireAuth } from '../middleware/authenticate'
import {
  requestEmailVerification,
  verifyEmail,
} from '../controllers/email-identity-controller'

const router = Router()

// Email verification opt-in endpoints (#367)
router.post('/email', requireAuth, requestEmailVerification)
router.get('/email/verify', verifyEmail)

export default router
