/**
 * Assistant tool registry — shared types (#318).
 *
 * A "tool" is a thin, allowlisted wrapper over an EXISTING service-layer
 * function (the same function a REST route or the agent loop already calls).
 * The model never gets a path to a raw Stellar primitive or a raw DB write —
 * see registry.ts and tests/unit/agent/tools/structural.test.ts, which assert
 * that structurally.
 */

import { z } from 'zod'
import type { SubAccountPermission } from '@prisma/client'

/** Who a tool call may act as. Mirrors src/middleware/subAccount.ts. */
export type ToolActorScope = 'own' | 'sub-account'

export interface ToolExecutionContext {
  /** The account the action is ultimately attributed to. */
  userId: string
  /**
   * Set when the caller is a parent acting on behalf of a child sub-account
   * (src/middleware/subAccount.ts). Passed straight through to the same
   * service-layer functions the REST routes already pass it to.
   */
  actingAsUserId?: string | null
  channel: 'whatsapp' | 'telegram' | 'api'
  /**
   * When true, the tool MUST NOT perform any write / side-effecting call. It
   * returns the same shape it would on a real execution (a preview) so the
   * grounding layer can show the user exactly what would happen.
   */
  dryRun?: boolean
}

export interface ToolResult {
  ok: boolean
  data?: unknown
  error?: string
}

export interface ToolDefinition<TArgs = any> {
  name: string
  description: string
  argsSchema: z.ZodType<TArgs>
  /** Read tools return live data and never move money or change state. */
  isReadOnly: boolean
  /**
   * Action tools ALWAYS require an explicit affirmative confirmation before
   * executing, regardless of model confidence — see
   * src/agent/assistant/confirmations.ts. This flag exists only to make the
   * requirement visible at the tool-definition call site; the confirmation
   * gate does not consult it (it gates every non-read-only tool).
   */
  requiresConfirmation: boolean
  /** Human-readable one-liner shown in the confirmation prompt. */
  summarize: (args: TArgs) => string
  execute: (args: TArgs, ctx: ToolExecutionContext) => Promise<ToolResult>
  /**
   * The SubAccountPermission a delegated caller (ctx.actingAsUserId set) must
   * hold on the target account to invoke this tool — enforced by the
   * assistant orchestrator via
   * src/middleware/subAccount.ts#checkSubAccountPermission before execute()
   * runs (including for a dry-run preview). Every tool must declare one, even
   * read tools (VIEW), so a delegated caller with no permission cannot use
   * the assistant to enumerate account data either.
   */
  subAccountPermission: SubAccountPermission
}

export function defineTool<TArgs>(
  def: ToolDefinition<TArgs>
): ToolDefinition<TArgs> {
  return def
}
