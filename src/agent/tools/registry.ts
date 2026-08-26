/**
 * Assistant tool registry (#318) — the ONLY surface the planner sees.
 *
 * Every entry wraps an existing service-layer function; nothing here talks to
 * src/stellar/contract.ts, `src/stellar/wallet.ts`'s signing paths, or issues
 * a raw Prisma write for money movement. That's asserted structurally by
 * tests/unit/agent/tools/structural.test.ts, which inspects this module's
 * import graph the same way
 * tests/integration/agent/strategy-follow.integration.test.ts pins
 * src/strategy/service.ts's.
 */

import { z } from 'zod'
import { ToolDefinition } from './types'
import { READ_TOOLS } from './readTools'
import { ACTION_TOOLS } from './actionTools'

export const ALL_TOOLS: readonly ToolDefinition[] = [
  ...READ_TOOLS,
  ...ACTION_TOOLS,
]

const TOOLS_BY_NAME: Record<string, ToolDefinition> = Object.fromEntries(
  ALL_TOOLS.map((tool) => [tool.name, tool])
)

export function getTool(name: string): ToolDefinition | undefined {
  return TOOLS_BY_NAME[name]
}

export function isKnownTool(name: string): boolean {
  return name in TOOLS_BY_NAME
}

/**
 * The Anthropic Messages API "tools" array. Built once at module load from
 * the same Zod schemas that validate the call, via Zod 4's native JSON Schema
 * conversion (z.toJSONSchema) — one schema, two consumers, so they can never
 * drift apart.
 */
export interface ModelToolSpec {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

function toInputSchema(schema: z.ZodType): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema, { target: 'draft-7' }) as Record<
    string,
    unknown
  >
  // Anthropic's tool spec wants a bare object schema, not a $schema wrapper.
  delete jsonSchema.$schema
  if (!('type' in jsonSchema)) {
    jsonSchema.type = 'object'
  }
  return jsonSchema
}

export function getModelToolSpecs(): ModelToolSpec[] {
  return ALL_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: toInputSchema(tool.argsSchema),
  }))
}
