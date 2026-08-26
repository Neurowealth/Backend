/**
 * Per-user and global token budgets for the assistant planner (#318).
 *
 * Fixed-window counters, in-memory per process. A soft limit deliberately: the
 * cost this guards against is a single user (or a runaway loop) burning
 * through the shared Anthropic key budget, not perfectly precise accounting
 * across a multi-pod deployment — see docs/openapi.yaml and the acceptance
 * criteria in issue #318 for the "degrade to the rule-based parser, never a
 * dead bot" contract this backs.
 */

import { config } from '../../config/env'
import { recordAssistantTokenSpend } from '../../utils/metrics'

interface WindowCounter {
  tokens: number
  windowStartedAt: number
}

const perUserCounters = new Map<string, WindowCounter>()
let globalCounter: WindowCounter = { tokens: 0, windowStartedAt: Date.now() }

function rollWindow(
  counter: WindowCounter,
  windowMs: number,
  now: number
): WindowCounter {
  if (now - counter.windowStartedAt >= windowMs) {
    return { tokens: 0, windowStartedAt: now }
  }
  return counter
}

export interface BudgetCheck {
  allowed: boolean
  reason?: 'per_user' | 'global'
}

/** Check whether `estimatedTokens` more can be spent right now, without consuming. */
export function checkBudget(
  userId: string,
  estimatedTokens: number
): BudgetCheck {
  const now = Date.now()

  globalCounter = rollWindow(
    globalCounter,
    config.assistant.globalBudgetWindowMs,
    now
  )
  if (
    globalCounter.tokens + estimatedTokens >
    config.assistant.globalTokenBudget
  ) {
    return { allowed: false, reason: 'global' }
  }

  const existing = perUserCounters.get(userId) ?? {
    tokens: 0,
    windowStartedAt: now,
  }
  const rolled = rollWindow(
    existing,
    config.assistant.perUserBudgetWindowMs,
    now
  )
  if (rolled.tokens + estimatedTokens > config.assistant.perUserTokenBudget) {
    perUserCounters.set(userId, rolled)
    return { allowed: false, reason: 'per_user' }
  }

  return { allowed: true }
}

/** Record actual token spend after a model call completes. */
export function recordSpend(userId: string, tokens: number): void {
  const now = Date.now()

  globalCounter = rollWindow(
    globalCounter,
    config.assistant.globalBudgetWindowMs,
    now
  )
  globalCounter.tokens += tokens

  const existing = perUserCounters.get(userId) ?? {
    tokens: 0,
    windowStartedAt: now,
  }
  const rolled = rollWindow(
    existing,
    config.assistant.perUserBudgetWindowMs,
    now
  )
  rolled.tokens += tokens
  perUserCounters.set(userId, rolled)

  recordAssistantTokenSpend(tokens)
}

/** Test seam. */
export function resetBudgetsForTests(): void {
  perUserCounters.clear()
  globalCounter = { tokens: 0, windowStartedAt: Date.now() }
}
