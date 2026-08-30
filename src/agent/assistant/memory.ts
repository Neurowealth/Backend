/**
 * Bounded per-user conversation memory for the assistant (#318).
 *
 * Redis-backed, TTL'd (src/config/redis.ts) so a follow-up ("what would that
 * have returned?") works without re-running a tool. When Redis is not
 * configured, cacheGet/cacheSet degrade to no-ops — the assistant still works,
 * it just has no cross-turn memory (every turn is treated as the start of a
 * new conversation), matching every other Redis-optional feature in this
 * codebase.
 */

import { cacheGet, cacheSet, cacheDel } from '../../config/redis'

export interface ConversationTurn {
  role: 'user' | 'assistant'
  content: string
  /** Tool calls executed on an assistant turn, with their results — grounding
   * data for follow-up questions ("what would that have returned?"). */
  toolCalls?: Array<{ name: string; args: unknown; result: unknown }>
  at: string
}

const MAX_TURNS = 20
const TTL_SECONDS = 30 * 60 // 30 minutes

function memoryKey(channel: string, userId: string): string {
  return `assistant:memory:${channel}:${userId}`
}

export async function getConversationHistory(
  channel: string,
  userId: string
): Promise<ConversationTurn[]> {
  const history = await cacheGet<ConversationTurn[]>(memoryKey(channel, userId))
  return history ?? []
}

export async function appendConversationTurn(
  channel: string,
  userId: string,
  turn: ConversationTurn
): Promise<void> {
  const history = await getConversationHistory(channel, userId)
  history.push(turn)
  const bounded = history.slice(-MAX_TURNS)
  await cacheSet(memoryKey(channel, userId), bounded, TTL_SECONDS)
}

export async function clearConversationHistory(
  channel: string,
  userId: string
): Promise<void> {
  await cacheDel(memoryKey(channel, userId))
}
