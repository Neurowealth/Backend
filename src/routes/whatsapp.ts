import { Router, Request, Response } from 'express'
import { Twilio } from 'twilio'
import { validateRequest } from 'twilio'
import { WhatsAppHandler } from '../whatsapp/handler'
import { logger } from '../utils/logger'
import { config } from '../config/env'

const router = Router()

// Initialize Twilio client
const twilio = new Twilio(
  process.env.TWILIO_ACCOUNT_SID!,
  process.env.TWILIO_AUTH_TOKEN!
)

/**
 * Health check endpoint for webhook verification
 */
router.get('/webhook', (req: Request, res: Response) => {
  logger.info('WhatsApp webhook health check')
  res.status(200).send('WhatsApp webhook is active')
})

/**
 * Handle incoming WhatsApp messages from Twilio
 */
router.post('/webhook', async (req: Request, res: Response) => {
  try {
    // Validate Twilio signature for security
    const isValidSignature = validateTwilioSignature(req)
    if (!isValidSignature) {
      logger.warn('Invalid Twilio signature', { body: req.body })
      return res.status(403).send('Invalid signature')
    }

    const { From: from, Body: body } = req.body

    if (!from || !body) {
      logger.warn('Missing required fields in webhook', { from, body })
      return res.status(400).send('Missing required fields')
    }

    // Clean phone number (Twilio format: whatsapp:+1234567890)
    const phoneNumber = from.replace('whatsapp:', '')

    logger.info('Received WhatsApp message', {
      from: phoneNumber,
      message: body.substring(0, 100) + (body.length > 100 ? '...' : '')
    })

    // Handle the message
    const result = await WhatsAppHandler.handleMessage(phoneNumber, body)

    // Send response back via TwiML
    const twiml = generateTwiMLResponse(result.message)

    res.type('text/xml')
    res.send(twiml)

  } catch (error) {
    logger.error('Error processing WhatsApp webhook', { error })
    const errorTwiML = generateTwiMLResponse(
      'Sorry, I encountered an error. Please try again later.'
    )
    res.type('text/xml')
    res.send(errorTwiML)
  }
})

/**
 * Validate Twilio webhook signature
 */
function validateTwilioSignature(req: Request): boolean {
  try {
    const twilioSignature = req.headers['x-twilio-signature'] as string
    const authToken = process.env.TWILIO_AUTH_TOKEN!

    if (!twilioSignature || !authToken) {
      return false
    }

    // Get the full URL
    const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`

    // Validate signature
    const isValid = validateRequest(
      authToken,
      twilioSignature,
      url,
      req.body
    )

    return isValid
  } catch (error) {
    logger.error('Error validating Twilio signature', { error })
    return false
  }
}

/**
 * Generate TwiML response for WhatsApp
 */
function generateTwiMLResponse(message: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${escapeXml(message)}</Message>
</Response>`
}

/**
 * Escape XML characters
 */
function escapeXml(unsafe: string): string {
  return unsafe.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '&': return '&amp;'
      case "'": return '&#39;'
      case '"': return '&quot;'
      default: return c
    }
  })
}

export default router