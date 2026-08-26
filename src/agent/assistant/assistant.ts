/**
 * The assistant orchestrator (#318).
 *
 * The single entry point every channel (WhatsApp, Telegram, REST
 * /api/v1/assistant/chat) calls. Owns:
 *   - the confirmation gate (an action tool never runs without an explicit
 *     affirmative reply to the EXACT proposal that was confirmed)
 *   - the bounded tool-use loop against the planner (read tools execute and
 *     feed results back so the model's final text is grounded in live data;
 *     an action tool is dry-run and handed to the confirmation gate, never
 *     executed inline)
 *   - budget enforcement and graceful degradation when the model is
 *     unavailable or the budget is exhausted
 *   - AgentLog auditing of every executed tool call
 */

import crypto from 'crypto'
import Anthropic from '@anthropic-ai/sdk'
import { logger } from '../../utils/logger'
import { getTool } from '../tools/registry'
import type { ToolExecutionContext } from '../tools/types'
import {
  buildAnthropicMessages,
  callModel,
  PlannerUnavailableError,
  validateProposedToolCall,
} from './planner'
import { appendConversationTurn, getConversationHistory } from './memory'
import { checkBudget, recordSpend } from './budget'
import {
  clearPendingToolConfirmation,
  getPendingToolConfirmation,
  isAffirmativeReply,
  isNegativeReply,
  markCallExecuted,
  setPendingToolConfirmation,
  wasCallExecuted,
} from './confirmations'
import {
  recordAssistantFallback,
  recordAssistantToolCall,
} from '../../utils/metrics'
import { logAgentAction } from '../router'
import { checkSubAccountPermission } from '../../middleware/subAccount'

export type AssistantChannel = 'whatsapp' | 'telegram' | 'api'

export interface AssistantRequest {
  userId: string
  channel: AssistantChannel
  message: string
  actingAsUserId?: string | null
}

export interface AssistantReply {
  text: string
  usedFallback: boolean
  pendingConfirmation?: boolean
}

const MAX_ROUNDS = 3
/** Rough pre-call estimate used only to gate the budget check before spend is known. */
const ESTIMATED_TOKENS_PER_CALL = 1500

/** Maps a tool execution onto the nearest AgentAction enum value for AgentLog. */
function agentActionFor(
  toolName: string
): 'DEPOSIT' | 'WITHDRAW' | 'REBALANCE' | 'ALERT' | 'ANALYZE' {
  switch (toolName) {
    case 'deposit':
      return 'DEPOSIT'
    case 'withdraw':
      return 'WITHDRAW'
    case 'rebalance':
      return 'REBALANCE'
    case 'create_alert_rule':
      return 'ALERT'
    default:
      return 'ANALYZE'
  }
}

async function auditToolCall(params: {
  userId: string
  actingAsUserId?: string | null
  toolName: string
  args: Record<string, unknown>
  result: { ok: boolean; data?: unknown; error?: string }
  durationMs: number
}): Promise<void> {
  await logAgentAction(
    agentActionFor(params.toolName),
    params.result.ok ? 'SUCCESS' : 'FAILED',
    {
      input: { toolName: params.toolName, args: params.args },
      output: params.result.data,
      error: params.result.error,
    },
    params.userId
  ).catch((err) => {
    logger.error('[Assistant] Failed to write AgentLog', {
      toolName: params.toolName,
      error: err instanceof Error ? err.message : String(err),
    })
  })
}

async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const tool = getTool(toolName)
  if (!tool) return { ok: false, error: `Unknown tool "${toolName}"` }

  // Sub-account delegation (#318): enforce the exact same permission gate the
  // REST routes do (src/middleware/subAccount.ts), including for a dry-run
  // preview — a delegate with no permission on this tool must not learn what
  // it would do either. Self-scoped calls (no actingAsUserId) skip this,
  // matching the middleware's self-access shortcut.
  if (ctx.actingAsUserId && ctx.actingAsUserId !== ctx.userId) {
    const permissionCheck = await checkSubAccountPermission(
      ctx.actingAsUserId,
      ctx.userId,
      tool.subAccountPermission
    )
    if (!permissionCheck.allowed) {
      recordAssistantToolCall(toolName, 'rejected')
      return {
        ok: false,
        error: 'You do not have permission to do that on this account.',
      }
    }
  }

  const start = Date.now()
  try {
    const result = await tool.execute(args, ctx)
    const durationMs = Date.now() - start
    recordAssistantToolCall(
      toolName,
      result.ok ? 'executed' : 'error',
      durationMs / 1000
    )
    if (!ctx.dryRun) {
      await auditToolCall({
        userId: ctx.userId,
        actingAsUserId: ctx.actingAsUserId,
        toolName,
        args,
        result,
        durationMs,
      })
    }
    return result
  } catch (error) {
    const durationMs = Date.now() - start
    recordAssistantToolCall(toolName, 'error', durationMs / 1000)
    const message =
      error instanceof Error ? error.message : 'Tool execution failed'
    logger.error('[Assistant] Tool execution threw', {
      toolName,
      error: message,
    })
    if (!ctx.dryRun) {
      await auditToolCall({
        userId: ctx.userId,
        actingAsUserId: ctx.actingAsUserId,
        toolName,
        args,
        result: { ok: false, error: message },
        durationMs,
      })
    }
    return { ok: false, error: message }
  }
}

function toolResultBlock(
  toolUseId: string,
  content: unknown
): Anthropic.ToolResultBlockParam {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: JSON.stringify(content).slice(0, 4000),
  }
}

/**
 * Handle a fresh (non-confirmation-reply) message: run the bounded
 * read-tool/answer loop, or stop at the first proposed action tool and hand
 * it to the confirmation gate with a dry-run preview attached.
 */
async function runPlannerLoop(
  req: AssistantRequest,
  history: Awaited<ReturnType<typeof getConversationHistory>>
): Promise<AssistantReply> {
  const messages = buildAnthropicMessages(history, req.message)
  let totalTokens = 0

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const result = await callModel(messages)
    totalTokens += result.usage.inputTokens + result.usage.outputTokens

    if (result.toolCalls.length === 0) {
      recordSpend(req.userId, totalTokens)
      const text = result.text ?? "I'm not sure how to help with that yet."
      await appendConversationTurn(req.channel, req.userId, {
        role: 'user',
        content: req.message,
        at: new Date().toISOString(),
      })
      await appendConversationTurn(req.channel, req.userId, {
        role: 'assistant',
        content: text,
        at: new Date().toISOString(),
      })
      return { text, usedFallback: false }
    }

    // Validate every proposed call against its own schema before anything
    // runs. An out-of-schema or hallucinated tool is rejected here, never
    // executed — the grounded error is fed back to the model as a
    // tool_result so it can retry or ask a clarifying question instead.
    const validated = result.toolCalls.map(validateProposedToolCall)
    const invalid = validated.filter((v) => !v.ok) as Array<
      Extract<(typeof validated)[number], { ok: false }>
    >
    for (const bad of invalid) {
      recordAssistantToolCall(bad.name, 'rejected')
      logger.warn('[Assistant] Rejected out-of-schema tool call', {
        userId: req.userId,
        tool: bad.name,
        error: bad.error,
      })
    }

    const valid = validated.filter((v) => v.ok) as Array<
      Extract<(typeof validated)[number], { ok: true }>
    >

    const actionCall = valid.find(
      (v) => getTool(v.call.name)?.isReadOnly === false
    )

    // Assistant's proposed content (including tool_use blocks) becomes the
    // next message so the follow-up round has the full exchange.
    messages.push({ role: 'assistant', content: result.rawContent })

    if (actionCall) {
      const tool = getTool(actionCall.call.name)!
      const ctx: ToolExecutionContext = {
        userId: req.userId,
        actingAsUserId: req.actingAsUserId,
        channel: req.channel,
        dryRun: true,
      }
      const preview = await executeTool(
        actionCall.call.name,
        actionCall.call.args,
        ctx
      )
      const callId = crypto.randomUUID()

      const summary = tool.summarize(actionCall.call.args)
      setPendingToolConfirmation(req.channel, req.userId, {
        toolName: actionCall.call.name,
        args: actionCall.call.args,
        summary,
        callId,
      })

      recordSpend(req.userId, totalTokens)

      const previewText = preview.ok
        ? `Preview: ${JSON.stringify(preview.data)}`
        : `I couldn't prepare that: ${preview.error}`

      const replyText = [
        `I'd like to: *${summary}*.`,
        previewText,
        'Reply "yes" to confirm or "no" to cancel.',
      ].join('\n')

      await appendConversationTurn(req.channel, req.userId, {
        role: 'user',
        content: req.message,
        at: new Date().toISOString(),
      })
      await appendConversationTurn(req.channel, req.userId, {
        role: 'assistant',
        content: replyText,
        toolCalls: [
          {
            name: actionCall.call.name,
            args: actionCall.call.args,
            result: preview,
          },
        ],
        at: new Date().toISOString(),
      })

      return { text: replyText, usedFallback: false, pendingConfirmation: true }
    }

    // Only read tools were proposed (and/or some were rejected) — execute
    // the read tools now and feed results back for a grounded final answer.
    const toolResultsForModel: Anthropic.ToolResultBlockParam[] = []
    for (const call of valid) {
      const ctx: ToolExecutionContext = {
        userId: req.userId,
        actingAsUserId: req.actingAsUserId,
        channel: req.channel,
        dryRun: false,
      }
      const toolResult = await executeTool(call.call.name, call.call.args, ctx)
      toolResultsForModel.push(toolResultBlock(call.call.id, toolResult))
    }
    for (const bad of invalid) {
      toolResultsForModel.push(
        toolResultBlock(bad.id, { ok: false, error: bad.error })
      )
    }

    messages.push({ role: 'user', content: toolResultsForModel })
  }

  // Exhausted the round budget without a final answer — ground out rather
  // than looping forever.
  recordSpend(req.userId, totalTokens)
  const text =
    "I gathered some information but couldn't finish that request. Could you rephrase it?"
  await appendConversationTurn(req.channel, req.userId, {
    role: 'user',
    content: req.message,
    at: new Date().toISOString(),
  })
  await appendConversationTurn(req.channel, req.userId, {
    role: 'assistant',
    content: text,
    at: new Date().toISOString(),
  })
  return { text, usedFallback: false }
}

/** Handle the user's reply to a parked action-tool confirmation. */
async function handleConfirmationReply(
  req: AssistantRequest
): Promise<AssistantReply> {
  const pending = getPendingToolConfirmation(req.channel, req.userId)!

  if (isNegativeReply(req.message)) {
    clearPendingToolConfirmation(req.channel, req.userId)
    return { text: 'Okay, cancelled. Nothing was done.', usedFallback: false }
  }

  if (!isAffirmativeReply(req.message)) {
    return {
      text: `You still have a pending action: ${pending.summary}. Reply "yes" to confirm or "no" to cancel.`,
      usedFallback: false,
      pendingConfirmation: true,
    }
  }

  // Confirmation is a platform rule, not a preference the user can bypass or
  // redirect — the only two branches above are affirm/negate/re-prompt.
  if (wasCallExecuted(pending.callId)) {
    clearPendingToolConfirmation(req.channel, req.userId)
    return { text: 'That action was already completed.', usedFallback: false }
  }

  clearPendingToolConfirmation(req.channel, req.userId)
  markCallExecuted(pending.callId)

  const ctx: ToolExecutionContext = {
    userId: req.userId,
    actingAsUserId: req.actingAsUserId,
    channel: req.channel,
    dryRun: false,
  }
  const result = await executeTool(pending.toolName, pending.args, ctx)

  const text = result.ok
    ? `Done — ${pending.summary}. ${JSON.stringify(result.data)}`
    : `That didn't go through: ${result.error}`

  await appendConversationTurn(req.channel, req.userId, {
    role: 'assistant',
    content: text,
    toolCalls: [{ name: pending.toolName, args: pending.args, result }],
    at: new Date().toISOString(),
  })

  return { text, usedFallback: false }
}

/**
 * Handle one inbound assistant message end-to-end. Never throws — a model or
 * budget failure returns a graceful degraded reply (usedFallback: true)
 * rather than a dead bot, per issue #318's failure-mode contract.
 */
export async function handleAssistantMessage(
  req: AssistantRequest
): Promise<AssistantReply> {
  const pending = getPendingToolConfirmation(req.channel, req.userId)
  if (pending) {
    return handleConfirmationReply(req)
  }

  const budgetCheck = checkBudget(req.userId, ESTIMATED_TOKENS_PER_CALL)
  if (!budgetCheck.allowed) {
    recordAssistantFallback('budget_exceeded')
    logger.warn('[Assistant] Budget exceeded, degrading', {
      userId: req.userId,
      reason: budgetCheck.reason,
    })
    return {
      text: "I'm handling a lot of requests right now — please try again in a few minutes, or use the app directly.",
      usedFallback: true,
    }
  }

  try {
    const history = await getConversationHistory(req.channel, req.userId)
    return await runPlannerLoop(req, history)
  } catch (error) {
    if (error instanceof PlannerUnavailableError) {
      recordAssistantFallback('model_error')
      return {
        text: 'I\'m having trouble understanding requests like that right now. Please try a specific command (e.g. "balance", "deposit 10"), or try again shortly.',
        usedFallback: true,
      }
    }
    logger.error('[Assistant] Unexpected orchestrator error', {
      userId: req.userId,
      error: error instanceof Error ? error.message : String(error),
    })
    recordAssistantFallback('model_error')
    return {
      text: 'Something went wrong on my end. Please try again shortly.',
      usedFallback: true,
    }
  }
}
