import Anthropic from '@anthropic-ai/sdk'
import { HttpClientAdapter } from '../utils/http-client'
import { config } from '../config'

export interface Intent {
  action: 'deposit' | 'withdraw' | 'balance' | 'earnings' | 'goal' | 'help' | 'unknown'
  amount?: number
  currency?: string
  all?: boolean
}

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || 'dummy_key',
})

const anthropicHttpClient = new HttpClientAdapter({
  timeoutMs: config.httpClient.timeoutMs,
  maxRetries: config.httpClient.maxRetries,
  baseDelayMs: config.httpClient.baseDelayMs,
  maxDelayMs: config.httpClient.maxDelayMs,
  circuitBreakerThreshold: config.httpClient.circuitBreakerThreshold,
  circuitBreakerResetMs: config.httpClient.circuitBreakerResetMs,
})

// Regex fallback
export function parseWithRegex(message: string): Intent | null {
  const lowerMsg = message.toLowerCase().trim()

  // Withdraw everything
  if (/withdraw\s+(all|everything)/i.test(lowerMsg)) {
    return { action: 'withdraw', all: true }
  }

  // Deposit/Withdraw with amount
  const actionMatch = lowerMsg.match(
    /(deposit|withdraw)\s+([\d.,]+)(?:\s+([a-z]+))?/i
  )
  if (actionMatch) {
    const action = actionMatch[1].toLowerCase() as 'deposit' | 'withdraw'
    const amount = parseFloat(actionMatch[2].replace(/,/g, ''))
    if (!isNaN(amount)) {
      const intent: Intent = { action, amount }
      if (actionMatch[3]) {
        intent.currency = actionMatch[3].toUpperCase()
      }
      return intent
    }
  }

  // Balance
  if (/balance|what'?s my balance|how much do i have/i.test(lowerMsg)) {
    return { action: 'balance' }
  }

  // Earnings / performance
  if (/earnings|performance|yield|apy/i.test(lowerMsg)) {
    return { action: 'earnings' }
  }

  // Savings goal (progress/status query — creation happens via the REST API)
  if (/goal/i.test(lowerMsg)) {
    return { action: 'goal' }
  }

  // Help
  if (/help|what can you do|commands/i.test(lowerMsg)) {
    return { action: 'help' }
  }

  return null
}

// Claude fallback
export async function parseWithClaude(message: string): Promise<Intent> {
  try {
    const response = await anthropicHttpClient.execute(async () => {
      return anthropic.messages.create({
        model: 'claude-3-haiku-20240307',
        max_tokens: 150,
        system: `You are an intent parser for a financial bot. Determine if the user wants to deposit, withdraw, check balance, view earnings/performance, check their savings goal progress, or needs help.
Return ONLY a JSON object representing the intent, matching this TypeScript interface exactly without any wrapper text or markdown:
{
  "action": "deposit" | "withdraw" | "balance" | "earnings" | "goal" | "help" | "unknown",
  "amount": number, // optional
  "currency": string, // optional
  "all": boolean // for "withdraw everything"
}`,
        messages: [{ role: 'user', content: message }],
      })
    }, 'anthropic.parseIntent')

    const contentBlock = response.content.find((c) => c.type === 'text')
    if (contentBlock && contentBlock.type === 'text') {
      const textContent = contentBlock.text
      const jsonStr = textContent.substring(
        textContent.indexOf('{'),
        textContent.lastIndexOf('}') + 1
      )
      if (jsonStr) {
        const parsed = JSON.parse(jsonStr)
        if (
          ['deposit', 'withdraw', 'balance', 'earnings', 'goal', 'help'].includes(
            parsed.action
          )
        ) {
          return parsed as Intent
        }
      }
    }
  } catch (error) {
    // Silently continue and fall back to unknown
  }

  return { action: 'unknown' }
}

export async function parseIntent(message: string): Promise<Intent> {
  if (!message || message.trim() === '') {
    return { action: 'unknown' }
  }

  try {
    // Try regex first (fast + free, handles ~80% of messages)
    const regexResult = parseWithRegex(message)
    if (regexResult) {
      return regexResult
    }

    // Fall back to Claude API if AI_MODE is not local
    if (process.env.AI_MODE !== 'local') {
      return await parseWithClaude(message)
    }
  } catch (error) {
    // Never throws - always degrade gracefully
  }

  return { action: 'unknown' }
}
