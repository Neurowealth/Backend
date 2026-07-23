import { parseIntent, type Intent } from '../nlp/parser'
import { formatGoalProgressReply } from './formatters'
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

function formatHelpMessage(): string {
  return [
    'Welcome to NeuroWealth! Here are some things you can ask me:',
    '- "balance" → check your wallet balance',
    '- "deposit <amount>" → get deposit instructions',
    '- "withdraw <amount>" → withdraw funds (if available)',
    '- "earnings" → see your performance',
    '- "goal" → check your savings goal progress',
    '- "help" → show this message again',
  ].join('\n')
}

function formatOtpMessage(code: string): string {
  return `Welcome to NeuroWealth! Your verification code is: ${code}\n\nReply with the 6-digit code to activate your account.`
}

function formatBalanceMessage(balance: number, address: string): string {
  return `Your current balance is ${balance.toFixed(2)} XLM.\nWallet: ${address}`
}

function formatDepositInstruction(amount: number, address: string): string {
  return `To deposit, send ${amount.toFixed(2)} XLM to your wallet address:\n${address}\n\nOnce the transaction is confirmed, reply "balance" to see your updated balance.`
}

function formatWithdrawConfirmation(
  amount: number,
  newBalance: number
): string {
  return `Withdrawal request received for ${amount.toFixed(2)} XLM.\nYour new balance will be ${newBalance.toFixed(2)} XLM once processed.`
}

function formatInsufficientFunds(balance: number, requested: number): string {
  return `You only have ${balance.toFixed(2)} XLM available, but you requested ${requested.toFixed(2)} XLM.\nTry a smaller amount or deposit more funds.`
}

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

function formatUnknownMessage(): string {
  return `Sorry, I didn't understand that.\n${formatHelpMessage()}`
}

function extractOtpCode(message: string): string | null {
  const match = message.match(/\b(\d{6})\b/)
  return match ? match[1] : null
}

/**
 * Financial / strategy-changing intents. When one of these originates from a
 * voice note it must be confirmed before execution (#288) — misrecognition on
 * a fund movement is materially worse than on a read-only query.
 */
const FINANCIAL_ACTIONS: ReadonlySet<Intent['action']> = new Set([
  'deposit',
  'withdraw',
])

function isFinancialIntent(intent: Intent): boolean {
  return FINANCIAL_ACTIONS.has(intent.action)
}

/** Affirmative reply to a pending confirmation ("yes", "confirm", "yeah"…). */
export function isAffirmative(message: string): boolean {
  return /^\s*(yes|yep|yeah|yup|confirm|confirmed|ok|okay|sure|correct|do it|go ahead|proceed|y)\s*[.!]*\s*$/i.test(
    message,
  )
}

/** Negative reply to a pending confirmation ("no", "cancel", "stop"…). */
export function isNegative(message: string): boolean {
  return /^\s*(no|nope|nah|cancel|stop|abort|don'?t|never mind|nevermind|n)\s*[.!]*\s*$/i.test(
    message,
  )
}

/** Human-readable echo of a financial intent for the confirmation prompt. */
export function summarizeIntent(intent: Intent): string {
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
 * Execute a parsed intent and produce the reply. This is the single place that
 * acts on an intent, shared by typed messages, confirmed voice commands, and
 * read-only voice commands — there is no voice-specific intent handling.
 */
async function executeIntent(
  intent: Intent,
  normalizedPhone: string,
): Promise<WhatsAppResponse> {
  switch (intent.action) {
    case 'balance': {
      const balance = getBalance(normalizedPhone) ?? 0
      const address = getUserWalletAddress(normalizedPhone) ?? 'unknown'
      return { body: formatBalanceMessage(balance, address) }
    }

    case 'deposit': {
      const amount = intent.amount
      if (!amount || amount <= 0) {
        return { body: 'Please specify a deposit amount, e.g. "deposit 10".' }
      }
      const address = getUserWalletAddress(normalizedPhone)
      return { body: formatDepositInstruction(amount, address ?? 'unknown') }
    }

    case 'withdraw': {
      const balance = getBalance(normalizedPhone) ?? 0
      const amount = intent.all ? balance : intent.amount
      if (!amount || amount <= 0) {
        return {
          body: 'Please specify a withdrawal amount, e.g. "withdraw 5" or "withdraw all".',
        }
      }
      if (amount > balance) {
        return { body: formatInsufficientFunds(balance, amount) }
      }
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
      const summary = await getPortfolioYieldSummary(normalizedPhone)
      if (!summary) {
        return {
          body: 'I could not find any tracked portfolio data for your account yet.',
        }
      }
      return { body: formatEarnings(summary) }
    }

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
  media: InboundMedia | undefined,
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
      `[Voice] Low-confidence transcription (${result.confidence.toFixed(2)} < ${config.transcription.confidenceThreshold}); asking user to repeat`,
    )
    return {
      reply:
        "I couldn't quite catch that. Please repeat your voice message or type your command.",
      fromVoice: true,
    }
  }

  return { text: result.text, fromVoice: true }
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

export async function handleWhatsAppMessage(
  from: string,
  message: string,
  media?: InboundMedia,
): Promise<WhatsAppResponse> {
  const normalizedPhone = normalizePhone(from)
  const user = await createOrGetUser(normalizedPhone)

  // If user is not verified, treat any 6-digit code as an OTP attempt.
  // OTP is text-only; a voice note here still triggers the resend path below.
  if (!user.verified) {
    const codeFromMessage = extractOtpCode(message)
    if (codeFromMessage) {
      const success = verifyOtp(normalizedPhone, codeFromMessage)
      if (success) {
        const wallet = getUserWalletAddress(normalizedPhone)
        return {
          body: `✅ Your account is now verified!\nYour wallet address is: ${wallet}\n\n${formatHelpMessage()}`,
        }
      }

      return {
        body: 'Invalid or expired OTP. Please request a new code by sending any message.',
      }
    }

    // Send OTP for new user or re-send if not verified
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

  return executeIntent(intent, normalizedPhone)
}
