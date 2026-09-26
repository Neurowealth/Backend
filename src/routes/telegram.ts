import express, { Request, Response } from 'express'
import { handleTelegramMessage } from '../telegram/handler'
import { messageDeliveryService } from '../messaging'
import { logger } from '../utils/logger'

const router = express.Router()

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || ''
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || ''

function verifyTelegramRequest(req: Request): boolean {
  const header = req.header('x-telegram-bot-api-secret-token')
  return Boolean(BOT_TOKEN && WEBHOOK_SECRET && header === WEBHOOK_SECRET)
}

router.get('/health', (_req: Request, res: Response) => {
  res.status(200).send('Telegram webhook is alive')
})

router.post('/', async (req: Request, res: Response) => {
  if (!verifyTelegramRequest(req)) {
    return res.status(401).send('Forbidden: invalid Telegram secret token')
  }

  const message = req.body?.message
  const chatId = message?.chat?.id
  const text = message?.text || ''

  if (!chatId || typeof chatId !== 'number') {
    return res.status(400).send('Bad request')
  }

  try {
    const reply = await handleTelegramMessage(chatId, text)
    const delivery = await messageDeliveryService.send({
      channel: 'TELEGRAM',
      recipient: String(chatId),
      body: reply,
      category: 'BOT_REPLY',
    })

    if (delivery.status === 'DEAD_LETTER' || delivery.status === 'FAILED') {
      logger.error('[Telegram webhook] Bot message delivery failed', {
        chatId,
        error: delivery.lastError,
      })
      return res.status(502).send('Bad Gateway')
    }

    return res.status(200).send('OK')
  } catch (error) {
    logger.error('[Telegram webhook] error handling message:', error)
    return res.status(500).send('Internal Server Error')
  }
})

export default router
