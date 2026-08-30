/**
 * Planner-side validation (#318): a proposed tool call is re-validated
 * against the tool's own Zod schema before anything runs. An unknown tool
 * name (a hallucination) or an out-of-schema argument set must be rejected as
 * a grounded error, never half-executed.
 */

import { validateProposedToolCall } from '../../../../src/agent/assistant/planner'

describe('validateProposedToolCall', () => {
  it('accepts a known tool with valid args and coerces defaults', () => {
    const result = validateProposedToolCall({
      id: 'call-1',
      name: 'withdraw',
      args: { amount: 25 },
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.call.name).toBe('withdraw')
      expect(result.call.args.amount).toBe(25)
      expect(result.call.args.assetSymbol).toBe('USDC')
    }
  })

  it('rejects a hallucinated tool name that is not in the registry', () => {
    const result = validateProposedToolCall({
      id: 'call-2',
      name: 'transfer_to_arbitrary_address',
      args: { destination: 'GABC...', amount: 1000000 },
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/Unknown tool/)
    }
  })

  it('rejects args that violate the tool schema (wrong type)', () => {
    const result = validateProposedToolCall({
      id: 'call-3',
      name: 'withdraw',
      args: { amount: 'a lot' },
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/tool_parse_error/)
    }
  })

  it('rejects args with an extra unrecognized field (strict schema)', () => {
    const result = validateProposedToolCall({
      id: 'call-4',
      name: 'withdraw',
      args: { amount: 25, assetSymbol: 'USDC', destinationOverride: 'GXYZ' },
    })

    expect(result.ok).toBe(false)
  })

  it('rejects a negative amount for a money-moving tool', () => {
    const result = validateProposedToolCall({
      id: 'call-5',
      name: 'deposit',
      args: { amount: -10 },
    })

    expect(result.ok).toBe(false)
  })

  it('accepts a read tool with no args', () => {
    const result = validateProposedToolCall({
      id: 'call-6',
      name: 'portfolio_value',
      args: {},
    })

    expect(result.ok).toBe(true)
  })
})
