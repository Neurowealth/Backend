import Anthropic from '@anthropic-ai/sdk'
import { HttpClientAdapter } from '../utils/http-client'
import { config } from '../config'

/**
 * Represents a parsed user intent for the financial bot.
 * - `action`: the primary operation the user wants to perform
 * - `amount`: numeric amount for deposit/withdraw/recurring-deposit actions (optional)
 * - `currency`: currency code, e.g. "USD", "ETH" (optional)
 * - `all`: true when the user wants to withdraw their entire balance
 * - `cadence`: schedule for a recurring deposit (create_recurring_deposit only)
 * - `metric` / `protocolName` / `comparator` / `threshold`: alert rule fields (alert_create only)
 * - `alertId`: id of the alert rule to remove (alert_delete only)
 */
export interface Intent {
  action:
    | 'deposit'
    | 'withdraw'
    | 'balance'
    | 'earnings'
    | 'help'
    | 'goal'
    | 'create_recurring_deposit'
    | 'pause_recurring_deposit'
    | 'alert_create'
    | 'alert_list'
    | 'alert_delete'
    | 'unknown'
  amount?: number
  currency?: string
  all?: boolean
  cadence?: 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY'
  metric?: string
  protocolName?: string
  comparator?: string
  threshold?: number
  alertId?: string
}

// Anthropic SDK client. Falls back to a dummy key so the module can still be
// imported (e.g. in tests) without ANTHROPIC_API_KEY set; real calls will
// fail auth if the dummy key is actually used.
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || 'dummy_key',
})

// Wraps outbound Anthropic API calls with timeout, retry/backoff, and
// circuit-breaker behavior so a flaky/slow API doesn't cascade failures
// through the bot.
const anthropicHttpClient = new HttpClientAdapter({
  timeoutMs: config.httpClient.timeoutMs,
  maxRetries: config.httpClient.maxRetries,
  baseDelayMs: config.httpClient.baseDelayMs,
  maxDelayMs: config.httpClient.maxDelayMs,
  circuitBreakerThreshold: config.httpClient.circuitBreakerThreshold,
  circuitBreakerResetMs: config.httpClient.circuitBreakerResetMs,
})

/**
 * Attempts to parse an intent using plain regex pattern matching.
 * This is the fast, free, deterministic path that handles the majority
 * of common phrasings without needing an LLM call.
 *
 * Returns `null` if no pattern matches, signaling the caller to fall
 * back to the Claude-based parser.
 */
export function parseWithRegex(message: string): Intent | null {
  const lowerMsg = message.toLowerCase().trim()

  // Matches phrases like "withdraw all" or "withdraw everything".
  // Checked before the generic amount-based match below since it has
  // no numeric amount.
  if (/withdraw\s+(all|everything)/i.test(lowerMsg)) {
    return { action: 'withdraw', all: true }
  }

  // Matches "deposit 100", "withdraw 50.25 usd", "deposit 1,000 eth", etc.
  // Group 1: action verb, Group 2: numeric amount (commas allowed),
  // Group 3: optional currency code.
  const actionMatch = lowerMsg.match(
    /(deposit|withdraw)\s+([\d.,]+)(?:\s+([a-z]+))?/i
  )
  if (actionMatch) {
    const action = actionMatch[1].toLowerCase() as 'deposit' | 'withdraw'
    // Strip thousands separators before parsing to a float.
    const amount = parseFloat(actionMatch[2].replace(/,/g, ''))
    if (!isNaN(amount)) {
      const intent: Intent = { action, amount }
      if (actionMatch[3]) {
        intent.currency = actionMatch[3].toUpperCase()
      }
      return intent
    }
  }

  // Matches common ways of asking for account balance.
  if (/balance|what'?s my balance|how much do i have/i.test(lowerMsg)) {
    return { action: 'balance' }
  }

  // Matches requests about earnings, performance, yield, or APY.
  if (/earnings|performance|yield|apy/i.test(lowerMsg)) {
    return { action: 'earnings' }
  }

  // Matches generic help/capability requests.
  if (/help|what can you do|commands/i.test(lowerMsg)) {
    return { action: 'help' }
  }

  // No regex pattern matched; let the caller decide whether to
  // escalate to the Claude-based parser.
  return null
}

/**
 * Falls back to the Claude API to classify intent for messages that the
 * regex parser couldn't handle (e.g. free-form or ambiguous phrasing).
 *
 * Always resolves to an `Intent` — never throws — so callers can treat
 * this as a safe, best-effort classification step. On any failure
 * (API error, malformed response, invalid JSON, unrecognized action)
 * it degrades to `{ action: 'unknown' }`.
 */
export async function parseWithClaude(message: string): Promise<Intent> {
  try {
    // Route the API call through the resilient HTTP client (retries,
    // timeout, circuit breaker) rather than calling the SDK directly.
    const response = await anthropicHttpClient.execute(async () => {
      return anthropic.messages.create({
        model: 'claude-3-haiku-20240307',
        max_tokens: 150,
        // System prompt instructs the model to act purely as an intent
        // classifier and return raw JSON only — no prose, no markdown
        // fences — so the response can be parsed directly.
        system: `You are an intent parser for a financial bot. Determine what the user wants: deposit, withdraw, check balance, view earnings/performance, check a savings goal, set up/pause a recurring deposit, create/list/delete a yield or price alert, or needs help.
Return ONLY a JSON object representing the intent, matching this TypeScript interface exactly without any wrapper text or markdown:
{
  "action": "deposit" | "withdraw" | "balance" | "earnings" | "help" | "goal" | "create_recurring_deposit" | "pause_recurring_deposit" | "alert_create" | "alert_list" | "alert_delete" | "unknown",
  "amount": number, // optional
  "currency": string, // optional
  "all": boolean, // for "withdraw everything"
  "cadence": "WEEKLY" | "BIWEEKLY" | "MONTHLY", // for create_recurring_deposit
  "metric": string, // for alert_create, e.g. "apy"
  "protocolName": string, // for alert_create
  "comparator": string, // for alert_create, e.g. "<", ">"
  "threshold": number, // for alert_create
  "alertId": string // for alert_delete
}`,
        messages: [{ role: 'user', content: message }],
      })
    }, 'anthropic.parseIntent')

    // Find the first text content block in the response (Claude may
    // return multiple content blocks; we only care about text here).
    const contentBlock = response.content.find((c) => c.type === 'text')
    if (contentBlock && contentBlock.type === 'text') {
      const textContent = contentBlock.text

      // Defensively extract just the JSON object substring in case the
      // model wraps it in extra text despite instructions not to.
      const jsonStr = textContent.substring(
        textContent.indexOf('{'),
        textContent.lastIndexOf('}') + 1
      )
      if (jsonStr) {
        const parsed = JSON.parse(jsonStr)

        // Validate that the returned action is one of the known,
        // expected values before trusting the parsed object as an
        // Intent. Guards against malformed or hallucinated responses.
        if (
          [
            'deposit',
            'withdraw',
            'balance',
            'earnings',
            'help',
            'goal',
            'create_recurring_deposit',
            'pause_recurring_deposit',
            'alert_create',
            'alert_list',
            'alert_delete',
          ].includes(parsed.action)
        ) {
          return parsed as Intent
        }
      }
    }
  } catch (error) {
    // Swallow any error (network, JSON parse, etc.) and fall through
    // to the 'unknown' intent below — this function must never throw.
  }

  return { action: 'unknown' }
}

/**
 * Main entry point for intent parsing. Tries the cheap regex parser
 * first, and only calls out to Claude if regex couldn't classify the
 * message and the bot isn't running in local-only mode.
 *
 * Guaranteed to never throw — any unexpected error results in an
 * 'unknown' intent so callers can handle it gracefully.
 */
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
    // (e.g. AI_MODE=local disables outbound LLM calls entirely,
    // useful for offline dev/testing or cost-sensitive deployments)
    if (process.env.AI_MODE !== 'local') {
      return await parseWithClaude(message)
    }
  } catch (error) {
    // Never throws - always degrade gracefully
  }

  return { action: 'unknown' }
}