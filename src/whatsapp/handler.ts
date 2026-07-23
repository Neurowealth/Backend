import { parseIntent } from '../nlp/parser'
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
import {
  createAlertRuleForWallet,
  listAlertRulesForWallet,
  deleteAlertRuleForWallet,
} from './alertManager'
import {
  formatAlertCreatedReply,
  formatAlertListReply,
  formatAlertDeletedReply,
} from './formatters'

export type WhatsAppResponse = {
  body: string
}

function formatHelpMessage(): string {
  return [
    'Welcome to NeuroWealth! Here are some things you can ask me:',
    '- "balance" → check your wallet balance',
    '- "deposit <amount>" → get deposit instructions',
    '- "withdraw <amount>" → withdraw funds (if available)',
    '- "earnings" → see your performance',
    '- "alert me when Blend apy < 5" → create a price/yield alert',
    '- "list my alerts" → see your alert rules',
    '- "delete alert <id>" → remove an alert rule',
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

export async function handleWhatsAppMessage(
  from: string,
  message: string
): Promise<WhatsAppResponse> {
  const normalizedPhone = normalizePhone(from)
  const user = await createOrGetUser(normalizedPhone)

  // If user is not verified, treat any 6-digit code as an OTP attempt.
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

  const intent = await parseIntent(message)

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
        return { body: 'Please tell me which alert to delete, e.g. "delete alert <id>".' }
      }
      const deleted = await deleteAlertRuleForWallet(walletAddress, intent.alertId)
      return { body: formatAlertDeletedReply(deleted) }
    }

    case 'unknown':
    default:
      return { body: formatUnknownMessage() }
  }
}
