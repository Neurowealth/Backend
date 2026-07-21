import Anthropic from '@anthropic-ai/sdk'
import { HttpClientAdapter } from '../utils/http-client'
import { config } from '../config'

export interface Intent {
  action:
    | 'deposit'
    | 'withdraw'
    | 'balance'
    | 'earnings'
    | 'help'
    | 'alert_create'
    | 'alert_list'
    | 'alert_delete'
    | 'unknown'
  amount?: number
  currency?: string
  all?: boolean
  // Alert-rule fields (action = alert_*). Kept optional so the union stays flat.
  metric?: 'PROTOCOL_APY' | 'PORTFOLIO_VALUE' | 'POSITION_DRAWDOWN'
  protocolName?: string
  comparator?: 'LT' | 'LTE' | 'GT' | 'GTE'
  threshold?: number
  alertId?: string
}

// Actions the Claude tier is allowed to emit. Kept in sync MANUALLY with the
// Intent union above and the handler switch in src/whatsapp/handler.ts — same
// manual-sync caveat as the deposit/withdraw intents (#281/#282). A new action
// must be added here or parseWithClaude will drop it as unknown.
const KNOWN_ACTIONS = [
  'deposit',
  'withdraw',
  'balance',
  'earnings',
  'help',
  'alert_create',
  'alert_list',
  'alert_delete',
] as const

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

/**
 * Parse alert-rule management phrases (create/list/delete) from a lowercased
 * message. Returns null when the message isn't alert-related so the caller can
 * fall through to the other regex tiers. Deliberately conservative — anything
 * ambiguous is left to the Claude tier.
 */
export function parseAlertIntent(lowerMsg: string): Intent | null {
  // List: "my alerts", "list alerts", "show my alert rules"
  if (/\b(list|show|view|my)\b.*\balerts?\b|\balerts?\b.*\b(list|status)\b/i.test(lowerMsg)) {
    return { action: 'alert_list' }
  }

  // Delete: "delete alert <id>", "remove alert <uuid>", "cancel alert <id>"
  const deleteMatch = lowerMsg.match(
    /\b(delete|remove|cancel|stop)\s+alert(?:\s+rule)?\s+([0-9a-f-]{6,})/i
  )
  if (deleteMatch) {
    return { action: 'alert_delete', alertId: deleteMatch[2] }
  }
  if (/\b(delete|remove|cancel|stop)\b.*\balerts?\b/i.test(lowerMsg)) {
    // Delete intent without a parseable id — still route to alert_delete so the
    // handler can ask which rule to remove.
    return { action: 'alert_delete' }
  }

  // Create: "alert me if <protocol> apy drops below 5",
  // "notify me when my portfolio drops below 1000".
  const isCreate =
    /\b(alert|notify|tell|warn|ping)\s+me\b/i.test(lowerMsg) ||
    /\b(set|create|add)\s+(an?\s+)?alert\b/i.test(lowerMsg)
  if (!isCreate) return null

  const intent: Intent = { action: 'alert_create' }

  // Metric + protocol
  if (/\bportfolio\b/i.test(lowerMsg)) {
    intent.metric = 'PORTFOLIO_VALUE'
  } else if (/\bdrawdown\b/i.test(lowerMsg)) {
    intent.metric = 'POSITION_DRAWDOWN'
  } else if (/\bapy\b|\byield\b/i.test(lowerMsg)) {
    intent.metric = 'PROTOCOL_APY'
    // Grab the protocol name preceding "apy"/"yield" (e.g. "blend apy").
    const protoMatch = lowerMsg.match(/\b([a-z][a-z0-9 ]*?)\s+(?:apy|yield)\b/i)
    if (protoMatch) {
      intent.protocolName = protoMatch[1].trim()
    }
  }

  // Comparator
  if (/\b(below|under|less than|drops? below|falls? below|<)\b/i.test(lowerMsg)) {
    intent.comparator = 'LT'
  } else if (/\b(above|over|greater than|exceeds?|rises? above|>)\b/i.test(lowerMsg)) {
    intent.comparator = 'GT'
  }

  // Threshold — first standalone number in the message.
  const numMatch = lowerMsg.match(/([\d]+(?:\.[\d]+)?)/)
  if (numMatch) {
    const n = parseFloat(numMatch[1])
    if (!isNaN(n)) intent.threshold = n
  }

  return intent
}

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

  // Alert rules — list / delete / create. Checked before the generic
  // "apy"/"yield" earnings keyword so "alert me when apy..." isn't swallowed.
  const alertIntent = parseAlertIntent(lowerMsg)
  if (alertIntent) {
    return alertIntent
  }

  // Balance
  if (/balance|what'?s my balance|how much do i have/i.test(lowerMsg)) {
    return { action: 'balance' }
  }

  // Earnings / performance
  if (/earnings|performance|yield|apy/i.test(lowerMsg)) {
    return { action: 'earnings' }
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
        system: `You are an intent parser for a financial bot. Determine what the user wants: deposit, withdraw, check balance, view earnings/performance, manage price/yield alert rules, or get help.
Return ONLY a JSON object representing the intent, matching this TypeScript interface exactly without any wrapper text or markdown:
{
  "action": "deposit" | "withdraw" | "balance" | "earnings" | "help" | "alert_create" | "alert_list" | "alert_delete" | "unknown",
  "amount": number, // optional
  "currency": string, // optional
  "all": boolean, // for "withdraw everything"
  // Alert fields (only for alert_* actions):
  "metric": "PROTOCOL_APY" | "PORTFOLIO_VALUE" | "POSITION_DRAWDOWN", // what to watch
  "protocolName": string, // required when metric = PROTOCOL_APY, e.g. "Blend"
  "comparator": "LT" | "LTE" | "GT" | "GTE", // below=LT, above=GT
  "threshold": number, // the trigger value (APY as a percent, e.g. 5 for 5%)
  "alertId": string // for alert_delete, if the user named a specific rule id
}
Examples: "alert me if Blend APY drops below 5" -> {"action":"alert_create","metric":"PROTOCOL_APY","protocolName":"Blend","comparator":"LT","threshold":5}. "show my alerts" -> {"action":"alert_list"}. "delete alert abc-123" -> {"action":"alert_delete","alertId":"abc-123"}.`,
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
        if ((KNOWN_ACTIONS as readonly string[]).includes(parsed.action)) {
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
