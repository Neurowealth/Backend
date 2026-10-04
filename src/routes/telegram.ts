import express, { Request, Response } from 'express'
import { handleTelegramMessage } from '../telegram/handler'
import { logger } from '../utils/logger'
import { enqueueOutboundNotification } from '../services/outboundNotifications'

const router = express.Router()

function verifyTelegramRequest(req: Request): boolean {
  const header = req.header('x-telegram-bot-api-secret-token')
  const botToken = process.env.TELEGRAM_BOT_TOKEN || ''
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET || ''
  return Boolean(botToken && webhookSecret && header === webhookSecret)
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
    const payload = {
      chat_id: chatId,
      text: reply,
      parse_mode: 'HTML',
    }

    await enqueueOutboundNotification('telegram', payload)
    return res.status(200).send('OK')
  } catch (error) {
    logger.error('[Telegram webhook] error handling message:', error)
    return res.status(500).send('Internal Server Error')
  }
})

export default router
