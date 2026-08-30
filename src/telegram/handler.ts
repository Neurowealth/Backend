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
import {
  getPendingConfirmation,
  setPendingConfirmation,
  clearPendingConfirmation,
} from './pendingConfirmations'
import {
  createAlertRuleForWallet,
  listAlertRulesForWallet,
  deleteAlertRuleForWallet,
} from './alertManager'
// Affirmative/negative/summarize semantics live in ONE place, shared with the
// WhatsApp handler, so both channels read "yes"/"no" identically.
import { isAffirmative, isNegative, summarizeIntent } from '../whatsapp/handler'
import {
  formatAlertCreatedReply,
  formatAlertListReply,
  formatAlertDeletedReply,
} from '../whatsapp/formatters'

export type TelegramResponse = {
  body: string
}

function formatUnknownMessage(): string {
  return `Sorry, I didn't understand that.\n${formatHelpMessage()}`
}

/**
 * Financial intents that must be confirmed before execution (#402). Telegram
 * has no voice channel, so — unlike WhatsApp, which gates only voice-originated
 * financial intents — every deposit/withdraw command over Telegram parks a
 * confirmation first, so a mistyped "withdraw 5000" can never move funds in
 * one step.
 */
const FINANCIAL_ACTIONS: ReadonlySet<Intent['action']> = new Set([
  'deposit',
  'withdraw',
])

function isFinancialIntent(intent: Intent): boolean {
  return FINANCIAL_ACTIONS.has(intent.action)
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
    case 'alert_create': {
      const walletAddress = getUserWalletAddress(chatId)
      if (!walletAddress) {
        return { body: 'I could not find your account. Please try again.' }
      }
      const result = await createAlertRuleForWallet(walletAddress, {
        metric: intent.metric,
        protocolName: intent.protocolName,
        comparator: intent.comparator,
        threshold: intent.threshold,
        // Telegram has no outbound messenger delivery leg yet (the
        // DeliveryChannel enum has no TELEGRAM value), so Telegram-originated
        // rules deliver over the shared alerting pipeline's always-on
        // real-time stream plus the opt-in webhook leg.
        deliveryChannel: 'WEBHOOK',
      })
      if (!result.ok) {
        return { body: result.error }
      }
      return { body: formatAlertCreatedReply(result.rule) }
    }
    case 'alert_list': {
      const walletAddress = getUserWalletAddress(chatId)
      if (!walletAddress) {
        return { body: 'I could not find your account. Please try again.' }
      }
      const rules = await listAlertRulesForWallet(walletAddress)
      return { body: formatAlertListReply(rules) }
    }
    case 'alert_delete': {
      const walletAddress = getUserWalletAddress(chatId)
      if (!walletAddress) {
        return { body: 'I could not find your account. Please try again.' }
      }
      if (!intent.alertId) {
        return {
          body: 'Please tell me which alert to delete, e.g. "delete alert <id>".',
        }
      }
      const deleted = await deleteAlertRuleForWallet(
        walletAddress,
        intent.alertId
      )
      return { body: formatAlertDeletedReply(deleted) }
    }
    case 'clarification':
      return { body: intent.prompt }
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

  // If a financial command is awaiting confirmation, the next message is
  // treated as the yes/no reply (#402) — mirroring WhatsApp's pending-
  // confirmation flow. Checked BEFORE parsing so an affirmative reply is
  // never re-parsed as a new command.
  const pending = getPendingConfirmation(normalizedChatId)
  if (pending) {
    if (isAffirmative(message)) {
      clearPendingConfirmation(normalizedChatId)
      return (await executeIntent(pending.intent, normalizedChatId)).body
    }
    if (isNegative(message)) {
      clearPendingConfirmation(normalizedChatId)
      return 'Okay, cancelled. Nothing was done.'
    }
    // Anything else: keep the pending action and re-prompt rather than
    // silently dropping it or acting on the new message.
    return `You still have a pending action: ${pending.summary}. Reply "yes" to confirm or "no" to cancel.`
  }

  const intent = await parseIntent(message)
  if (intent.action === 'unknown') {
    const assistantReply = await tryAssistantFallback(message, normalizedChatId)
    if (assistantReply) return assistantReply.body
    return formatUnknownMessage()
  }

  // Confirm-before-execute for financial commands (#402). Every Telegram
  // deposit/withdraw parks a confirmation first — see FINANCIAL_ACTIONS.
  if (isFinancialIntent(intent)) {
    const summary = summarizeIntent(intent)
    setPendingConfirmation(normalizedChatId, intent, summary)
    return `I heard: *${summary}*.\nReply "yes" to confirm or "no" to cancel.`
  }

  return (await executeIntent(intent, normalizedChatId)).body
}
