/**
 * #316 — client→server message schemas.
 *
 * The receive side is a control channel and nothing else, so the interesting
 * cases are the refusals: unknown message types, unknown keys, and topics that
 * are not in the vocabulary.
 */

import { clientMessageSchema } from '../../../src/ws/protocol'

describe('clientMessageSchema', () => {
  it('accepts a subscribe with topics', () => {
    const result = clientMessageSchema.safeParse({
      type: 'subscribe',
      topics: ['portfolio', 'alerts'],
    })
    expect(result.success).toBe(true)
  })

  it('accepts a resume with afterSeq 0 (replay everything retained)', () => {
    const result = clientMessageSchema.safeParse({
      type: 'resume',
      topics: ['transactions'],
      afterSeq: 0,
    })
    expect(result.success).toBe(true)
  })

  it('rejects an unknown topic', () => {
    const result = clientMessageSchema.safeParse({
      type: 'subscribe',
      topics: ['admin'],
    })
    expect(result.success).toBe(false)
  })

  it('rejects an empty topic list', () => {
    const result = clientMessageSchema.safeParse({
      type: 'subscribe',
      topics: [],
    })
    expect(result.success).toBe(false)
  })

  it('rejects a negative afterSeq', () => {
    const result = clientMessageSchema.safeParse({
      type: 'resume',
      topics: ['portfolio'],
      afterSeq: -1,
    })
    expect(result.success).toBe(false)
  })

  it('rejects unknown keys rather than ignoring them', () => {
    const result = clientMessageSchema.safeParse({
      type: 'subscribe',
      topics: ['portfolio'],
      replayEverything: true,
    })
    expect(result.success).toBe(false)
  })

  it('rejects a write-shaped message — v1 is server→client only', () => {
    const result = clientMessageSchema.safeParse({
      type: 'place_order',
      amount: '100',
    })
    expect(result.success).toBe(false)
  })
})
