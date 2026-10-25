/**
 * WhatsApp message handler.
 *
 * Entry point: handleWhatsAppMessage(from, message, media?). For each inbound
 * message it:
 *   1. normalizes the sender's phone number and finds/creates their user;
 *   2. if the user is not yet verified, runs the OTP flow (send or check a
 *      6-digit code) and stops there;
 *   3. if the message is a voice note, transcribes it (asking the user to
 *      repeat or type if that fails or confidence is low);
 *   4. resolves any pending yes/no confirmation for a voice-originated
 *      financial action;
 *   5. otherwise parses the text into an intent (balance, deposit, withdraw,
 *      earnings, goal, recurring deposits, alerts, help) and returns the
 *      matching reply, optionally handing unrecognised requests to the
 *      tool-calling assistant.
 *
 * The small format* helpers below (and those in ./formatters) only build reply
 * text.
 */

import { parseIntent, type Intent } from '../nlp/parser'
import {
  normalizePhone,
  createOrGetUser,
  generateOtp,
  verifyOtp,
  getBalance,
  getUserWalletAddress,
  getPortfolioYieldSummary,
  getGoalStatus,
  decrementBalance,
} from './userManager'
import db from '../db'
import {
  createAlertRuleForWallet,
  listAlertRulesForWallet,
  deleteAlertRuleForWallet,
} from './alertManager'
import {
  formatAlertCreatedReply,
  formatAlertListReply,
  formatAlertDeletedReply,
  formatGoalProgressReply,
} from './formatters'
import { logger } from '../utils/logger'
import { config } from '../config'
import { downloadTwilioMedia } from './mediaDownloader'
import { getDefaultTranscriptionProvider } from './transcription/registry'
import {
  UnsupportedAudioError,
  TranscriptionUnavailableError,
} from './transcription/types'
import {
  getPendingConfirmation,
  setPendingConfirmation,
  clearPendingConfirmation,
} from './pendingConfirmations'
import { handleAssistantMessage } from '../agent/assistant/assistant'

/** What the webhook sends back to the user: a single plain-text message. */
export type WhatsAppResponse = {
  body: string
}

/**
 * Inbound media on a WhatsApp message (Twilio MediaUrl0 / MediaContentType0).
 * Present only for voice notes and other attachments.
 */
export type InboundMedia = {
  url: string
  contentType: string
}

/** Command menu shown on /help, after verification, and on unrecognised input. */
function formatHelpMessage(): string {
  return [
    'Welcome to NeuroWealth! Here are some things you can ask me:',
    '- "balance" → check your wallet balance',
    '- "deposit <amount>" → get deposit instructions',
    '- "withdraw <amount>" → withdraw funds (if available)',
    '- "earnings" → see your performance',
    '- "set up recurring deposit 50 weekly" → start automatic deposits',
    '- "pause recurring deposit" → pause your scheduled deposits',
    '- "alert me when Blend apy < 5" → create a price/yield alert',
    '- "list my alerts" → see your alert rules',
    '- "delete alert <id>" → remove an alert rule',
    '- "help" → show this message again',
  ].join('\n')
}

/** Message carrying the one-time code sent to unverified users. */
function formatOtpMessage(code: string): string {
  return `Welcome to NeuroWealth! Your verification code is: ${code}\n\nReply with the 6-digit code to activate your account.`
}

/** Balance in XLM (2 decimal places) plus the user's wallet address. */
function formatBalanceMessage(balance: number, address: string): string {
  return `Your current balance is ${balance.toFixed(2)} XLM.\nWallet: ${address}`
}

/** Tells the user where to send funds; the deposit itself happens on-chain. */
function formatDepositInstruction(amount: number, address: string): string {
  return `To deposit, send ${amount.toFixed(2)} XLM to your wallet address:\n${address}\n\nOnce the transaction is confirmed, reply "balance" to see your updated balance.`
}

/** Acknowledges a withdrawal and shows the balance that will result from it. */
function formatWithdrawConfirmation(
  amount: number,
  newBalance: number
): string {
  return `Withdrawal request received for ${amount.toFixed(2)} XLM.\nYour new balance will be ${newBalance.toFixed(2)} XLM once processed.`
}

/** Shown when a withdrawal request exceeds the available balance. */
function formatInsufficientFunds(balance: number, requested: number): string {
  return `You only have ${balance.toFixed(2)} XLM available, but you requested ${requested.toFixed(2)} XLM.\nTry a smaller amount or deposit more funds.`
}

/**
 * Earnings summary in plain text. `averageApy` is a fraction (0.05) and is
 * shown as a percentage. The "30 days" wording is fixed, so `periodEarnings`
 * is expected to be the 30-day figure.
 */
function formatEarnings(input: {
  totalBalance: number
  totalEarnings: number
  periodEarnings: number
  averageApy: number
}): string {
  return [
    `Your portfolio balance is ${input.totalBalance.toFixed(2)} XLM equivalent.`,
    `Total earnings to date: ${input.totalEarnings.toFixed(2)} XLM.`,
    `Earnings over the last 30 days: ${input.periodEarnings.toFixed(2)} XLM.`,
    `Average APY across your tracked positions: ${(input.averageApy * 100).toFixed(2)}%.`,
  ].join('\n')
}

/** Fallback reply: apologise, then show the help menu so the user can retry. */
function formatUnknownMessage(): string {
  return `Sorry, I didn't understand that.\n${formatHelpMessage()}`
}

/**
 * Find a 6-digit code anywhere in the message, e.g. "my code is 123456".
 * `\b` word boundaries mean a longer digit run (like a 7+ digit number) will
 * not match. Returns null if no code is found.
 */
function extractOtpCode(message: string): string | null {
  const match = message.match(/\b(\d{6})\b/)
  return match ? match[1] : null
}

/**
 * Execute a parsed intent and produce the reply. This is the single place that
 * acts on an intent, shared by typed messages, confirmed voice commands, and
 * read-only voice commands — there is no voice-specific intent handling.
 */
async function executeIntent(
  intent: Intent,
  normalizedPhone: string
): Promise<WhatsAppResponse> {
  switch (intent.action) {
    case 'balance': {
      // Fall back to safe defaults rather than failing if data is missing.
      const balance = getBalance(normalizedPhone) ?? 0
      const address = getUserWalletAddress(normalizedPhone) ?? 'unknown'
      return { body: formatBalanceMessage(balance, address) }
    }

    case 'deposit': {
      // Deposits are on-chain: we only validate the amount and tell the user
      // where to send funds. No balance is changed here.
      const amount = intent.amount
      if (!amount || amount <= 0) {
        return { body: 'Please specify a deposit amount, e.g. "deposit 10".' }
      }
      const address = getUserWalletAddress(normalizedPhone)
      return { body: formatDepositInstruction(amount, address ?? 'unknown') }
    }

    case 'withdraw': {
      const balance = getBalance(normalizedPhone) ?? 0
      // "withdraw all" uses the full balance; otherwise the parsed amount.
      // (With a zero balance, "withdraw all" falls into the "specify an
      // amount" reply below because the amount is 0.)
      const amount = intent.all ? balance : intent.amount
      if (!amount || amount <= 0) {
        return {
          body: 'Please specify a withdrawal amount, e.g. "withdraw 5" or "withdraw all".',
        }
      }
      if (amount > balance) {
        return { body: formatInsufficientFunds(balance, amount) }
      }
      // The balance is reduced immediately, and the reply says the request
      // is "received" with the new balance applying "once processed".
      const newBalance = decrementBalance(normalizedPhone, amount)
      return { body: formatWithdrawConfirmation(amount, newBalance) }
    }

    case 'goal': {
      const progress = await getGoalStatus(normalizedPhone)
      if (!progress) {
        return {
          body: "You don't have a savings goal set up yet. Set one up in the app to start tracking progress.",
        }
      }
      return { body: formatGoalProgressReply(progress) }
    }

    case 'help':
      return { body: formatHelpMessage() }

    case 'earnings': {
      // May be null when the user has no tracked portfolio data yet.
      const summary = await getPortfolioYieldSummary(normalizedPhone)
      if (!summary) {
        return {
          body: 'I could not find any tracked portfolio data for your account yet.',
        }
      }
      return { body: formatEarnings(summary) }
    }

    case 'create_recurring_deposit': {
      // Both an amount and a schedule are required before creating a plan.
      const amount = intent.amount
      const cadence = intent.cadence
      if (!amount || amount <= 0) {
        return {
          body: 'Please specify an amount, e.g. "recurring deposit 50 weekly".',
        }
      }
      if (!cadence) {
        return {
          body: 'Please specify a schedule: weekly, biweekly, or monthly.',
        }
      }
      // Map the phone to a DB user via the wallet address.
      const wallet = getUserWalletAddress(normalizedPhone)
      if (!wallet) {
        return { body: 'Your account is not fully set up yet.' }
      }
      const user = await db.user.findFirst({
        where: { walletAddress: wallet },
        select: { id: true },
      })
      if (!user) {
        return { body: 'Your account is not fully set up yet.' }
      }
      // First run is one full interval from now (not immediately).
      const nextRunAt = new Date()
      switch (cadence) {
        case 'WEEKLY':
          nextRunAt.setDate(nextRunAt.getDate() + 7)
          break
        case 'BIWEEKLY':
          nextRunAt.setDate(nextRunAt.getDate() + 14)
          break
        case 'MONTHLY':
          nextRunAt.setMonth(nextRunAt.getMonth() + 1)
          break
      }
      const plan = await db.recurringDepositPlan.create({
        data: {
          userId: user.id,
          amount,
          assetSymbol: 'USDC',
          cadence,
          nextRunAt,
        },
      })
      return {
        body: [
          '✅ *Recurring deposit created*',
          `Amount: *${amount} USDC*`,
          `Schedule: *${cadence}*`,
          `First run: _${nextRunAt.toLocaleDateString()}_`,
          '_Your deposits will run automatically on schedule._',
        ].join('\n'),
      }
    }

    case 'pause_recurring_deposit': {
      const wallet = getUserWalletAddress(normalizedPhone)
      if (!wallet) {
        return { body: 'Your account is not fully set up yet.' }
      }
      const user = await db.user.findFirst({
        where: { walletAddress: wallet },
        select: { id: true },
      })
      if (!user) {
        return { body: 'Your account is not fully set up yet.' }
      }
      const activePlans = await db.recurringDepositPlan.findMany({
        where: { userId: user.id, status: 'ACTIVE' },
      })
      if (activePlans.length === 0) {
        return { body: 'You have no active recurring deposits to pause.' }
      }
      // Pauses every active plan at once, not just one.
      await db.recurringDepositPlan.updateMany({
        where: { userId: user.id, status: 'ACTIVE' },
        data: { status: 'PAUSED' },
      })
      return {
        body: `✅ *${activePlans.length} recurring deposit(s) paused*\nYou can resume them anytime with "resume recurring deposit".`,
      }
    }

    case 'alert_create': {
      const walletAddress = getUserWalletAddress(normalizedPhone)
      if (!walletAddress) {
        return { body: 'I could not find your account. Please try again.' }
      }
      const result = await createAlertRuleForWallet(walletAddress, {
        metric: intent.metric,
        protocolName: intent.protocolName,
        comparator: intent.comparator,
        threshold: intent.threshold,
        // WhatsApp-originated rules deliver over WhatsApp by default.
        deliveryChannel: 'WHATSAPP',
      })
      if (!result.ok) {
        return { body: result.error }
      }
      return { body: formatAlertCreatedReply(result.rule) }
    }

    case 'alert_list': {
      const walletAddress = getUserWalletAddress(normalizedPhone)
      if (!walletAddress) {
        return { body: 'I could not find your account. Please try again.' }
      }
      const rules = await listAlertRulesForWallet(walletAddress)
      return { body: formatAlertListReply(rules) }
    }

    case 'alert_delete': {
      const walletAddress = getUserWalletAddress(normalizedPhone)
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
      // The parser needs more information; relay its follow-up question.
      return { body: intent.prompt }

    // 'unknown' and any action the parser might add later land here, so the
    // user always gets a reply instead of silence.
    case 'unknown':
    default:
      return { body: formatUnknownMessage() }
  }
}

/**
 * Resolve the text to act on for a message. For a voice note this downloads and
 * transcribes the audio; for a text message it returns the body verbatim.
 *
 * Returns either { text, fromVoice } to proceed with parsing, or { reply } with
 * a ready-made user-facing message when the voice note could not be used
 * (unsupported format, low confidence, provider outage). Raw audio is discarded
 * as soon as transcription returns — never persisted.
 */
async function resolveMessageText(
  message: string,
  media: InboundMedia | undefined
): Promise<
  { text: string; fromVoice: boolean } | { reply: string; fromVoice: boolean }
> {
  if (!media) {
    return { text: message, fromVoice: false }
  }

  let audio
  try {
    audio = await downloadTwilioMedia(media.url, media.contentType)
  } catch (err) {
    return { reply: mediaErrorReply(err), fromVoice: true }
  }

  let result
  try {
    const provider = getDefaultTranscriptionProvider()
    result = await provider.transcribe(audio)
  } catch (err) {
    return { reply: mediaErrorReply(err), fromVoice: true }
  }

  if (result.confidence < config.transcription.confidenceThreshold) {
    logger.info(
      `[Voice] Low-confidence transcription (${result.confidence.toFixed(2)} < ${config.transcription.confidenceThreshold}); asking user to repeat`
    )
    return {
      reply:
        "I couldn't quite catch that. Please repeat your voice message or type your command.",
      fromVoice: true,
    }
  }

  return { text: result.text, fromVoice: true }
}

/**
 * Resolve a WhatsApp phone's DB-backed account id, the same lookup
 * getPortfolioYieldSummary uses. Returns null (never throws) so a lookup
 * failure degrades to the existing "I didn't understand that" reply rather
 * than surfacing an error — see the assistant fallback below.
 */
async function resolveDbUserId(phone: string): Promise<string | null> {
  try {
    const walletAddress = getUserWalletAddress(phone)
    if (!walletAddress) return null
    const user = await db.user.findFirst({
      where: { walletAddress },
      select: { id: true },
    })
    return user?.id ?? null
  } catch (error) {
    logger.error(
      '[Assistant] Failed to resolve WhatsApp user for assistant fallback',
      {
        error: error instanceof Error ? error.message : String(error),
      }
    )
    return null
  }
}

/**
 * Tool-calling assistant fallback (#318) for requests the rule-based parser
 * doesn't recognize. Gated behind config.assistant.enabled — see its
 * definition in src/config/env.ts for the rollout rationale. Never throws:
 * any failure (model down, budget exhausted, DB lookup failure) degrades to
 * the existing formatUnknownMessage() reply, so this can never make an
 * "unknown" message WORSE than it already was.
 */
async function tryAssistantFallback(
  intent: Intent,
  text: string,
  normalizedPhone: string
): Promise<WhatsAppResponse | null> {
  if (intent.action !== 'unknown' || !config.assistant.enabled) return null

  const userId = await resolveDbUserId(normalizedPhone)
  if (!userId) return null

  try {
    const reply = await handleAssistantMessage({
      userId,
      channel: 'whatsapp',
      message: text,
    })
    return { body: reply.text }
  } catch (error) {
    logger.error('[Assistant] WhatsApp assistant fallback failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/** Map a media/transcription error onto the right user-facing fallback. */
function mediaErrorReply(err: unknown): string {
  if (err instanceof UnsupportedAudioError) {
    return "I can't process that audio format. Please try again or type your command."
  }
  if (err instanceof TranscriptionUnavailableError) {
    logger.warn(`[Voice] Transcription unavailable: ${err.message}`)
    return "Voice messages aren't available right now. Please type your command."
  }
  logger.error('[Voice] Unexpected error handling voice note', {
    error: err instanceof Error ? err.message : String(err),
  })
  return "Voice messages aren't available right now. Please type your command."
}

const FINANCIAL_ACTIONS: ReadonlySet<Intent['action']> = new Set([
  'deposit',
  'withdraw',
])

function isFinancialIntent(intent: Intent): boolean {
  return FINANCIAL_ACTIONS.has(intent.action)
}

function isAffirmative(message: string): boolean {
  return /^\s*(yes|yep|yeah|yup|confirm|confirmed|ok|okay|sure|correct|do it|go ahead|proceed|y)\s*[.!]*\s*$/i.test(
    message
  )
}

function isNegative(message: string): boolean {
  return /^\s*(no|nope|nah|cancel|stop|abort|don'?t|never mind|nevermind|n)\s*[.!]*\s*$/i.test(
    message
  )
}

function summarizeIntent(intent: Intent): string {
  switch (intent.action) {
    case 'deposit':
      return `deposit ${intent.amount ?? ''}`.trim()
    case 'withdraw':
      return intent.all
        ? 'withdraw all'
        : `withdraw ${intent.amount ?? ''}`.trim()
    default:
      return intent.action
  }
}

/**
 * Handle one inbound WhatsApp message and produce the reply to send back.
 *
 * @param from    Sender's phone number as provided by WhatsApp (normalized
 *                before use so the same person always maps to one user).
 * @param message Raw text the user sent (may be empty for a voice note).
 * @param media   Voice note or other attachment, if the message has one.
 */
export async function handleWhatsAppMessage(
  from: string,
  message: string,
  media?: InboundMedia
): Promise<WhatsAppResponse> {
  const normalizedPhone = normalizePhone(from)
  // First contact creates the user; later contacts return the existing one.
  const user = await createOrGetUser(normalizedPhone)

  // --- Verification gate ----------------------------------------------------
  // Unverified users can't use any commands; the only things they can do are
  // submit an OTP or be sent a new one.

  // If user is not verified, treat any 6-digit code as an OTP attempt.
  // OTP is text-only; a voice note here still triggers the resend path below.
  if (!user.verified) {
    const codeFromMessage = extractOtpCode(message)
    if (codeFromMessage) {
      const success = verifyOtp(normalizedPhone, codeFromMessage)
      if (success) {
        // Verified: show the wallet address and the command menu.
        const wallet = getUserWalletAddress(normalizedPhone)
        return {
          body: `✅ Your account is now verified!\nYour wallet address is: ${wallet}\n\n${formatHelpMessage()}`,
        }
      }

      // Wrong or expired code. No new code is sent in this branch; the user
      // gets one the next time they send a message without a 6-digit number.
      return {
        body: 'Invalid or expired OTP. Please request a new code by sending any message.',
      }
    }

    // Send OTP for new user or re-send if not verified
    // (each non-code message from an unverified user generates a fresh code)
    const otp = generateOtp(normalizedPhone)
    return { body: formatOtpMessage(otp) }
  }

  // Resolve the text to act on — transcribing first if this is a voice note.
  const resolved = await resolveMessageText(message, media)
  if ('reply' in resolved) {
    return { body: resolved.reply }
  }
  const { text, fromVoice } = resolved

  // If a voice-originated financial action is awaiting confirmation, the next
  // message (voice OR text) is interpreted as the yes/no reply.
  const pending = getPendingConfirmation(normalizedPhone)
  if (pending) {
    if (isAffirmative(text)) {
      clearPendingConfirmation(normalizedPhone)
      return executeIntent(pending.intent, normalizedPhone)
    }
    if (isNegative(text)) {
      clearPendingConfirmation(normalizedPhone)
      return { body: 'Okay, cancelled. Nothing was done.' }
    }
    // Anything else: keep the pending action and re-prompt rather than
    // silently dropping it or acting on the new message.
    return {
      body: `You still have a pending action: ${pending.summary}. Reply "yes" to confirm or "no" to cancel.`,
    }
  }

  const intent = await parseIntent(text)

  // Confirm-before-execute for financial intents that came from voice. This is
  // a security control against misrecognition and must not be bypassable.
  if (fromVoice && isFinancialIntent(intent)) {
    const summary = summarizeIntent(intent)
    setPendingConfirmation(normalizedPhone, intent, summary)
    return {
      body: `I heard: *${summary}*.\nReply "yes" to confirm or "no" to cancel.`,
    }
  }

  // Tool-calling assistant (#318): only reached for the 'unknown' bucket —
  // every intent the rule-based parser DOES recognize keeps going through
  // executeIntent exactly as before. Falls back to formatUnknownMessage()
  // below when disabled, unavailable, or the user has no DB account yet.
  const assistantReply = await tryAssistantFallback(
    intent,
    text,
    normalizedPhone
  )
  if (assistantReply) return assistantReply

  return executeIntent(intent, normalizedPhone)
}
