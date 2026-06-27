import express, { Request, Response, NextFunction } from 'express'
import { validateRequest, twiml } from 'twilio'
import { handleWhatsAppMessage } from '../whatsapp/handler'
import { logger } from '../utils/logger'
import { validate } from '../middleware/validate'
import { whatsappWebhookSchema } from '../validators/webhook-validators'

const router = express.Router()

/**
 * Middleware to allow URL-encoded bodies for Twilio webhooks.
 * Twilio sends webhook data as application/x-www-form-urlencoded.
 */
function allowUrlEncodedBodies(req: Request, _res: Response, next: NextFunction) {
  ;(req as any).allowUrlEncoded = true
  next()
}

/**
 * Health check for Twilio webhook
 */
router.get('/webhook', (_req: Request, res: Response) => {
  res.status(200).send('WhatsApp webhook is alive')
})

/**
 * Handles incoming WhatsApp messages from Twilio.
 *
 * Signature validation is performed whenever TWILIO_AUTH_TOKEN is set.
 * If the token is absent the request is rejected with 403 — preventing
 * spoofed calls even on staging/dev where NODE_ENV is not 'production'.
 * https://www.twilio.com/docs/usage/security#validating-requests
 */
router.post('/webhook', allowUrlEncodedBodies, validate({ body: whatsappWebhookSchema }), async (req: Request, res: Response) => {
  const authToken = process.env.TWILIO_AUTH_TOKEN

  if (!authToken) {
    // Token not configured: reject rather than silently skip validation
    return res.status(403).send('Forbidden: TWILIO_AUTH_TOKEN not configured')
  }

  const signature = req.header('x-twilio-signature')

  if (!signature) {
    return res.status(403).send('Forbidden: x-twilio-signature header is required')
  }

  const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`
  const isValid = validateRequest(authToken, signature, url, req.body)

  if (!isValid) {
    return res.status(403).send('Forbidden: invalid Twilio signature')
  }

  const from = (req.body.From as string) || ''
  const body = (req.body.Body as string) || ''

  try {
    const response = await handleWhatsAppMessage(from, body)
    const responseTwiml = new twiml.MessagingResponse()
    responseTwiml.message(response.body)
    res.type('text/xml').send(responseTwiml.toString())
  } catch (error) {
    logger.error('[WhatsApp webhook] error handling message:', error)
    const errorTwiml = new twiml.MessagingResponse()
    errorTwiml.message('Sorry, something went wrong processing your request.')
    res.type('text/xml').send(errorTwiml.toString())
  }
})

export default router
