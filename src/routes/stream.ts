import { Router } from 'express'
import { requireAuth } from '../middleware/authenticate'
import { issueStreamTicket } from '../controllers/stream-ticket-controller'
import { handleSseConnection } from '../sse/handler'

const router = Router()

// Stream ticket endpoint (authenticated via Bearer JWT)
router.post('/ticket', requireAuth, issueStreamTicket)

// SSE Fallback Transport Endpoint
router.get('/sse', handleSseConnection)

export default router
