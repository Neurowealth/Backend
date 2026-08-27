import Anthropic from '@anthropic-ai/sdk'
import { HttpClientAdapter } from '../utils/http-client'
import { config } from '../config'

/**
 * Represents a parsed user intent for the financial bot.
 *
 * This is a discriminated union so TypeScript can safely narrow the
 * available properties based on `action`.
 */
export type Intent =
  | {
      action: 'deposit'
      amount?: number
      currency?: string
    }
  | {
      action: 'withdraw'
      amount?: number
      currency?: string
      all?: boolean
    }
  | {
      action: 'balance'
    }
  | {
      action: 'earnings'
    }
  | {
      action: 'help'
    }
  | {
      action: 'goal'
    }
  | {
      action: 'create_recurring_deposit'
      amount?: number
      cadence?: 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY'
    }
  | {
      action: 'pause_recurring_deposit'
    }
  | {
      action: 'alert_create'
      metric: string
      protocolName: string
      comparator: string
      threshold: number
    }
  | {
      action: 'alert_list'
    }
  | {
      action: 'alert_delete'
      alertId?: string
    }
  | {
      action: 'unknown'
    }

// ---------------------------------------------------------------------------
// Anthropic client
// ---------------------------------------------------------------------------

/**
 * Anthropic SDK client.
 *
 * A dummy key allows this module to be imported in tests/environments where
 * ANTHROPIC_API_KEY isn't configured. Actual requests with the dummy key will
 * fail authentication, which is handled by parseWithClaude().
 */
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || 'dummy_key',
})

/**
 * Resilient HTTP wrapper around outbound Anthropic calls.
 */
const anthropicHttpClient = new HttpClientAdapter({
  timeoutMs: config.httpClient.timeoutMs,
  maxRetries: config.httpClient.maxRetries,
  baseDelayMs: config.httpClient.baseDelayMs,
  maxDelayMs: config.httpClient.maxDelayMs,
  circuitBreakerThreshold: config.httpClient.circuitBreakerThreshold,
  circuitBreakerResetMs: config.httpClient.circuitBreakerResetMs,
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type RecurringCadence = 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY'

function normalizeCadence(value: string): RecurringCadence | null {
  switch (value.toLowerCase()) {
    case 'weekly':
      return 'WEEKLY'
    case 'biweekly':
    case 'bi-weekly':
    case 'every two weeks':
      return 'BIWEEKLY'
    case 'monthly':
      return 'MONTHLY'
    default:
      return null
  }
}

function normalizeComparator(value: string): string {
  switch (value.trim().toLowerCase()) {
    case '<':
    case 'less than':
    case 'below':
    case 'under':
      return '<'

    case '<=':
    case 'less than or equal to':
    case 'at most':
      return '<='

    case '>':
    case 'greater than':
    case 'above':
    case 'over':
      return '>'

    case '>=':
    case 'greater than or equal to':
    case 'at least':
      return '>='

    case '=':
    case '==':
    case 'equals':
    case 'equal to':
      return '='

    default:
      return value.trim()
  }
}

/**
 * Safely extracts a positive number from text.
 */
function parseAmount(value: string): number | null {
  const amount = parseFloat(value.replace(/,/g, ''))

  if (!Number.isFinite(amount) || amount <= 0) {
    return null
  }

  return amount
}

/**
 * Runtime validation for a Claude-produced Intent.
 *
 * Never trust an LLM response merely because it was cast to TypeScript.
 */
function isValidIntent(value: unknown): value is Intent {
  if (!value || typeof value !== 'object') {
    return false
  }

  const candidate = value as Record<string, unknown>

  if (typeof candidate.action !== 'string') {
    return false
  }

  switch (candidate.action) {
    case 'balance':
    case 'earnings':
    case 'help':
    case 'goal':
    case 'pause_recurring_deposit':
    case 'alert_list':
    case 'unknown':
      return true

    case 'deposit':
      return (
        (candidate.amount === undefined ||
          (typeof candidate.amount === 'number' &&
            Number.isFinite(candidate.amount))) &&
        (candidate.currency === undefined ||
          typeof candidate.currency === 'string')
      )

    case 'withdraw':
      return (
        (candidate.amount === undefined ||
          (typeof candidate.amount === 'number' &&
            Number.isFinite(candidate.amount))) &&
        (candidate.currency === undefined ||
          typeof candidate.currency === 'string') &&
        (candidate.all === undefined || typeof candidate.all === 'boolean')
      )

    case 'create_recurring_deposit':
      return (
        (candidate.amount === undefined ||
          (typeof candidate.amount === 'number' &&
            Number.isFinite(candidate.amount))) &&
        (candidate.cadence === undefined ||
          candidate.cadence === 'WEEKLY' ||
          candidate.cadence === 'BIWEEKLY' ||
          candidate.cadence === 'MONTHLY')
      )

    case 'alert_create':
      return (
        typeof candidate.metric === 'string' &&
        candidate.metric.length > 0 &&
        typeof candidate.protocolName === 'string' &&
        candidate.protocolName.length > 0 &&
        typeof candidate.comparator === 'string' &&
        candidate.comparator.length > 0 &&
        typeof candidate.threshold === 'number' &&
        Number.isFinite(candidate.threshold)
      )

    case 'alert_delete':
      return (
        candidate.alertId === undefined || typeof candidate.alertId === 'string'
      )

    default:
      return false
  }
}

// ---------------------------------------------------------------------------
// Regex parser
// ---------------------------------------------------------------------------

/**
 * Attempts to parse an intent using deterministic regex matching.
 *
 * This path is:
 * - fast
 * - free
 * - deterministic
 * - safe for tests
 * - independent of Claude
 *
 * Returns null when the message isn't recognized and can therefore be
 * escalated to Claude when AI_MODE isn't "local".
 */
export function parseWithRegex(message: string): Intent | null {
  const lowerMsg = message.toLowerCase().trim()

  if (!lowerMsg) {
    return null
  }

  // -------------------------------------------------------------------------
  // Withdraw all
  // -------------------------------------------------------------------------

  if (
    /^(?:please\s+)?withdraw\s+(?:all|everything)\s*[.!?]*$/i.test(lowerMsg)
  ) {
    return {
      action: 'withdraw',
      all: true,
    }
  }

  // -------------------------------------------------------------------------
  // Deposit / withdraw with amount
  // -------------------------------------------------------------------------

  const actionMatch = lowerMsg.match(
    /^(?:please\s+)?(deposit|withdraw)\s+([\d.,]+)(?:\s+([a-z]+))?\s*[.!?]*$/i
  )

  if (actionMatch) {
    const action = actionMatch[1].toLowerCase() as 'deposit' | 'withdraw'
    const amount = parseAmount(actionMatch[2])

    if (amount !== null) {
      const intent: Intent =
        action === 'deposit'
          ? {
              action: 'deposit',
              amount,
            }
          : {
              action: 'withdraw',
              amount,
            }

      if (actionMatch[3]) {
        intent.currency = actionMatch[3].toUpperCase()
      }

      return intent
    }
  }

  // -------------------------------------------------------------------------
  // Balance
  // -------------------------------------------------------------------------

  if (
    /^(?:please\s+)?(?:check\s+)?balance[.!?]*$/i.test(lowerMsg) ||
    /^what'?s\s+my\s+balance[.!?]*$/i.test(lowerMsg) ||
    /^how\s+much\s+(?:money\s+)?do\s+i\s+have[.!?]*$/i.test(lowerMsg)
  ) {
    return {
      action: 'balance',
    }
  }

  // -------------------------------------------------------------------------
  // Earnings / performance
  // -------------------------------------------------------------------------

  if (
    /^(?:show\s+)?(?:my\s+)?(?:earnings|performance|yield|apy)[.!?]*$/i.test(
      lowerMsg
    ) ||
    /\b(?:show|check|view)\s+(?:my\s+)?(?:earnings|performance|yield|apy)\b/i.test(
      lowerMsg
    )
  ) {
    return {
      action: 'earnings',
    }
  }

  // -------------------------------------------------------------------------
  // Goal
  // -------------------------------------------------------------------------

  if (
    /^goal[.!?]*$/i.test(lowerMsg) ||
    /^(?:show|check|view)\s+(?:my\s+)?(?:savings\s+)?goal(?:\s+progress)?[.!?]*$/i.test(
      lowerMsg
    ) ||
    /how\s+am\s+i\s+doing\s+on\s+(?:my\s+)?(?:savings\s+)?goal/i.test(lowerMsg)
  ) {
    return {
      action: 'goal',
    }
  }

  // -------------------------------------------------------------------------
  // Help
  // -------------------------------------------------------------------------

  if (/^(?:help|commands|what\s+can\s+you\s+do)[.!?]*$/i.test(lowerMsg)) {
    return {
      action: 'help',
    }
  }

  // -------------------------------------------------------------------------
  // Create recurring deposit
  //
  // Examples:
  // "recurring deposit 50 weekly"
  // "create recurring deposit 50 weekly"
  // "set up recurring deposit 50 monthly"
  // "automatic deposit 100 biweekly"
  // -------------------------------------------------------------------------

  const recurringMatch = lowerMsg.match(
    /^(?:(?:please\s+)?(?:create|set\s+up|start)\s+)?(?:a\s+)?(?:recurring|automatic|scheduled)\s+deposit\s+([\d.,]+)\s+(weekly|biweekly|bi-weekly|monthly)\s*[.!?]*$/i
  )

  if (recurringMatch) {
    const amount = parseAmount(recurringMatch[1])
    const cadence = normalizeCadence(recurringMatch[2])

    if (amount !== null && cadence !== null) {
      return {
        action: 'create_recurring_deposit',
        amount,
        cadence,
      }
    }
  }

  // Also support:
  // "deposit 50 weekly"
  // "deposit 50 every week"
  const recurringDepositMatch = lowerMsg.match(
    /^(?:(?:please\s+)?(?:set\s+up|start)\s+)?(?:recurring\s+)?deposit\s+([\d.,]+)\s+(weekly|biweekly|bi-weekly|monthly|every\s+week|every\s+two\s+weeks|every\s+month)\s*[.!?]*$/i
  )

  if (recurringDepositMatch) {
    const amount = parseAmount(recurringDepositMatch[1])
    const cadenceText = recurringDepositMatch[2]
      .replace(/^every\s+week$/i, 'weekly')
      .replace(/^every\s+two\s+weeks$/i, 'biweekly')
      .replace(/^every\s+month$/i, 'monthly')

    const cadence = normalizeCadence(cadenceText)

    if (amount !== null && cadence !== null) {
      return {
        action: 'create_recurring_deposit',
        amount,
        cadence,
      }
    }
  }

  // -------------------------------------------------------------------------
  // Pause recurring deposit
  // -------------------------------------------------------------------------

  if (
    /^(?:please\s+)?(?:pause|stop)\s+(?:my\s+)?(?:recurring|scheduled|automatic)\s+deposit(?:s)?[.!?]*$/i.test(
      lowerMsg
    )
  ) {
    return {
      action: 'pause_recurring_deposit',
    }
  }

  // -------------------------------------------------------------------------
  // List alerts
  // -------------------------------------------------------------------------

  if (
    /^(?:list|show|view)\s+(?:my\s+)?alerts?[.!?]*$/i.test(lowerMsg) ||
    /^alerts?[.!?]*$/i.test(lowerMsg)
  ) {
    return {
      action: 'alert_list',
    }
  }

  // -------------------------------------------------------------------------
  // Delete alert
  //
  // Examples:
  // "delete alert 123"
  // "remove alert abc"
  // -------------------------------------------------------------------------

  const alertDeleteMatch = lowerMsg.match(
    /^(?:please\s+)?(?:delete|remove)\s+alert\s+([a-z0-9_-]+)\s*[.!?]*$/i
  )

  if (alertDeleteMatch) {
    return {
      action: 'alert_delete',
      alertId: alertDeleteMatch[1],
    }
  }

  // -------------------------------------------------------------------------
  // Create alert
  //
  // Examples:
  // "alert me when Blend apy < 5"
  // "alert me when Blend apy is below 5"
  // "alert me when Blend apy > 10"
  // -------------------------------------------------------------------------

  const alertMatch = lowerMsg.match(
    /^(?:please\s+)?alert\s+(?:me\s+)?when\s+(.+?)\s+(?:is\s+)?(<=|>=|<|>|=|below|above|under|over|less\s+than|greater\s+than|at\s+most|at\s+least|equals?)\s+([\d.,]+)\s*[.!?]*$/i
  )

  if (alertMatch) {
    const subject = alertMatch[1].trim()
    const comparator = normalizeComparator(alertMatch[2])
    const threshold = parseAmount(alertMatch[3])

    if (threshold !== null) {
      // Try to split "Blend apy" into protocol + metric.
      const parts = subject.split(/\s+/)

      let protocolName = subject
      let metric = 'apy'

      if (parts.length >= 2) {
        const possibleMetric = parts[parts.length - 1]

        if (
          /^(apy|yield|price|tvl|apr|rate|balance|earnings)$/i.test(
            possibleMetric
          )
        ) {
          metric = possibleMetric.toLowerCase()
          protocolName = parts.slice(0, -1).join(' ')
        }
      }

      return {
        action: 'alert_create',
        metric,
        protocolName,
        comparator,
        threshold,
      }
    }
  }

  // -------------------------------------------------------------------------
  // No match
  // -------------------------------------------------------------------------

  return null
}

// ---------------------------------------------------------------------------
// Claude parser
// ---------------------------------------------------------------------------

/**
 * Falls back to Claude when regex cannot classify a message.
 *
 * Claude is only called when AI_MODE !== "local".
 */
export async function parseWithClaude(message: string): Promise<Intent> {
  try {
    const response = await anthropicHttpClient.execute(async () => {
      return anthropic.messages.create({
        model: 'claude-3-haiku-20240307',
        max_tokens: 250,

        system: `
You are an intent parser for a financial WhatsApp bot.

Classify the user's message into exactly one of these actions:

- deposit
- withdraw
- balance
- earnings
- help
- goal
- create_recurring_deposit
- pause_recurring_deposit
- alert_create
- alert_list
- alert_delete
- unknown

Return ONLY a JSON object.
Do not include markdown.
Do not include explanations.
Do not include code fences.

Schemas:

deposit:
{
  "action": "deposit",
  "amount": number,
  "currency": string
}

withdraw:
{
  "action": "withdraw",
  "amount": number,
  "currency": string,
  "all": boolean
}

balance:
{
  "action": "balance"
}

earnings:
{
  "action": "earnings"
}

help:
{
  "action": "help"
}

goal:
{
  "action": "goal"
}

create_recurring_deposit:
{
  "action": "create_recurring_deposit",
  "amount": number,
  "cadence": "WEEKLY" | "BIWEEKLY" | "MONTHLY"
}

pause_recurring_deposit:
{
  "action": "pause_recurring_deposit"
}

alert_create:
{
  "action": "alert_create",
  "metric": string,
  "protocolName": string,
  "comparator": string,
  "threshold": number
}

alert_list:
{
  "action": "alert_list"
}

alert_delete:
{
  "action": "alert_delete",
  "alertId": string
}

unknown:
{
  "action": "unknown"
}

For "withdraw everything", use:
{
  "action": "withdraw",
  "all": true
}

Do not invent an amount when one was not provided.
Do not invent an alert ID.
`.trim(),

        messages: [
          {
            role: 'user',
            content: message,
          },
        ],
      })
    }, 'anthropic.parseIntent')

    const contentBlock = response.content.find(
      (content) => content.type === 'text'
    )

    if (!contentBlock || contentBlock.type !== 'text') {
      return { action: 'unknown' }
    }

    const textContent = contentBlock.text.trim()

    const start = textContent.indexOf('{')
    const end = textContent.lastIndexOf('}')

    if (start === -1 || end === -1 || end < start) {
      return { action: 'unknown' }
    }

    const jsonStr = textContent.substring(start, end + 1)

    const parsed: unknown = JSON.parse(jsonStr)

    if (!isValidIntent(parsed)) {
      return { action: 'unknown' }
    }

    return parsed
  } catch {
    return { action: 'unknown' }
  }
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

/**
 * Main entry point.
 *
 * Parsing order:
 *
 * 1. Empty input -> unknown
 * 2. Regex -> deterministic/local result
 * 3. Claude -> only when AI_MODE !== "local"
 * 4. Unknown fallback
 *
 * This guarantees the parser never throws.
 */
export async function parseIntent(message: string): Promise<Intent> {
  if (!message || message.trim() === '') {
    return { action: 'unknown' }
  }

  try {
    const regexResult = parseWithRegex(message)

    if (regexResult) {
      return regexResult
    }

    if (process.env.AI_MODE !== 'local') {
      return await parseWithClaude(message)
    }
  } catch {
    // Intent parsing must never break the WhatsApp handler.
  }

  return { action: 'unknown' }
}
