import { parseIntent, type Intent } from '../nlp/parser'
import {
  createOrGetTelegramUser,
  createLinkCode,
  linkTelegramChat,
  getBalance,
  getUserWalletAddress,
  decrementBalance,
  getTelegramUser,
} from './userManager'
import {
  formatBalanceMessage,
  formatDepositInstruction,
  formatHelpMessage,
  formatLinkInstructions,
  formatWithdrawConfirmation,
} from './formatters'
import { logger } from '../utils/logger'
import { config } from '../config'
import db from '../db'
import { handleAssistantMessage } from '../agent/assistant/assistant'

export type TelegramResponse = {
  body: string
}

function formatUnknownMessage(): string {
  return `Sorry, I didn't understand that.\n${formatHelpMessage()}`
}

/**
 * Tool-calling assistant fallback (#318), mirroring
 * src/whatsapp/handler.ts's tryAssistantFallback — same rollout gate
 * (config.assistant.enabled, off by default) and the same "never make an
 * unknown message worse" contract: any failure here returns null and the
 * caller falls back to formatUnknownMessage().
 */
async function tryAssistantFallback(
  text: string,
  chatId: string
): Promise<TelegramResponse | null> {
  if (!config.assistant.enabled) return null

  try {
    const walletAddress = getUserWalletAddress(chatId)
    if (!walletAddress) return null
    const user = await db.user.findFirst({
      where: { walletAddress },
      select: { id: true },
    })
    if (!user) return null

    const reply = await handleAssistantMessage({
      userId: user.id,
      channel: 'telegram',
      message: text,
    })
    return { body: reply.text }
  } catch (error) {
    logger.error('[Assistant] Telegram assistant fallback failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

function extractLinkCode(message: string): string | null {
  const match = message.match(/\blink\s+([A-Z0-9-]+)/i)
  return match ? match[1] : null
}

async function executeIntent(
  intent: Intent,
  chatId: string
): Promise<TelegramResponse> {
  switch (intent.action) {
    case 'balance': {
      const balance = getBalance(chatId) ?? 0
      const address = getUserWalletAddress(chatId) ?? 'unknown'
      return { body: formatBalanceMessage(balance, address) }
    }
    case 'deposit': {
      const amount = intent.amount
      if (!amount || amount <= 0) {
        return { body: 'Please specify a deposit amount, e.g. "/deposit 10".' }
      }
      const address = getUserWalletAddress(chatId) ?? 'unknown'
      return { body: formatDepositInstruction(amount, address) }
    }
    case 'withdraw': {
      const balance = getBalance(chatId) ?? 0
      const amount = intent.all ? balance : intent.amount
      if (!amount || amount <= 0) {
        return {
          body: 'Please specify a withdrawal amount, e.g. "/withdraw 5" or "/withdraw all".',
        }
      }
      if (amount > balance) {
        return { body: `You only have ${balance.toFixed(2)} XLM available.` }
      }
      const newBalance = decrementBalance(chatId, amount)
      return { body: formatWithdrawConfirmation(amount, newBalance) }
    }
    case 'help':
      return { body: formatHelpMessage() }
    default:
      return { body: formatUnknownMessage() }
  }
}

export async function handleTelegramMessage(
  chatId: number | string,
  message: string
): Promise<string> {
  const normalizedChatId = String(chatId)
  const user = await createOrGetTelegramUser(normalizedChatId)

  if (!user.linked) {
    const linkCode = extractLinkCode(message)
    if (linkCode) {
      try {
        await linkTelegramChat(normalizedChatId, linkCode)
        return '✅ Your Telegram chat is now linked to your account.'
      } catch (error) {
        logger.warn('[Telegram] invalid link code', { error })
        return 'That link code is invalid or expired. Please try again.'
      }
    }

    const code = createLinkCode(normalizedChatId)
    return formatLinkInstructions(code)
  }

  const intent = await parseIntent(message)
  if (intent.action === 'unknown') {
    const assistantReply = await tryAssistantFallback(message, normalizedChatId)
    if (assistantReply) return assistantReply.body
    return formatUnknownMessage()
  }

  const response = await executeIntent(intent, normalizedChatId)
  return response.body
}
