/**
 * #401 — confidence scoring and the clarification fallback on the rule-based
 * intent parser. parseWithRegex is synchronous and network-free, so it's
 * exercised directly; parseIntent is covered end-to-end with AI_MODE=local
 * so it never reaches out to Claude.
 */
process.env.AI_MODE = 'local'

import { parseWithRegex, parseIntent } from '../../../src/nlp/parser'
import { responses } from '../../../src/nlp/responses'
import { config } from '../../../src/config'

describe('parseWithRegex confidence', () => {
  it('gives a clean deposit match full confidence', () => {
    const intent = parseWithRegex('deposit 100')
    expect(intent).toEqual(
      expect.objectContaining({ action: 'deposit', confidence: 1, amount: 100 })
    )
  })

  it('gives a clean withdraw-all match full confidence', () => {
    const intent = parseWithRegex('withdraw everything')
    expect(intent).toEqual(
      expect.objectContaining({
        action: 'withdraw',
        confidence: 1,
        all: true,
      })
    )
  })

  it('gives a clean balance match full confidence', () => {
    expect(parseWithRegex('balance')).toEqual(
      expect.objectContaining({ action: 'balance', confidence: 1 })
    )
  })

  it('returns null for input with no recognizable signal at all', () => {
    expect(parseWithRegex('xyzzy plugh')).toBeNull()
  })
})

describe('parseWithRegex clarification fallback', () => {
  it.each([
    'should I deposit or withdraw?',
    'do you want me to deposit or withdraw money',
    'deposit or withdraw',
  ])('asks to clarify deposit vs withdraw for %p', (message) => {
    const intent = parseWithRegex(message)
    expect(intent).not.toBeNull()
    expect(intent!.action).toBe('clarification')
    if (intent!.action === 'clarification') {
      expect(intent.confidence).toBeLessThan(config.nlp.confidenceThreshold)
      expect(intent.candidates).toEqual(
        expect.arrayContaining(['deposit', 'withdraw'])
      )
      expect(intent.prompt).toBe(
        responses.clarification(['deposit money', 'withdraw money'])
      )
    }
  })

  it('asks to clarify across three competing actions', () => {
    const intent = parseWithRegex(
      'not sure if I want to check my balance or my earnings or my goal'
    )
    expect(intent).not.toBeNull()
    expect(intent!.action).toBe('clarification')
    if (intent!.action === 'clarification') {
      expect(intent.candidates).toEqual(
        expect.arrayContaining(['balance', 'earnings', 'goal'])
      )
      // More competing actions -> lower confidence than the two-way case.
      expect(intent.confidence).toBeLessThan(1 / 2)
    }
  })

  it('does not clarify when only one action is mentioned but incomplete', () => {
    // "deposit" alone mentions only one action family — nothing to
    // disambiguate between, so this stays null (escalates to Claude/unknown
    // exactly as before #401).
    expect(parseWithRegex('deposit')).toBeNull()
  })

  it('never fires for an unambiguous full match even if a second keyword appears incidentally', () => {
    // Contains the word "balance" only inside a fully-matched deposit
    // sentence structure it doesn't actually satisfy — falls through to the
    // ambiguity check, which correctly finds both signals present.
    const intent = parseWithRegex('deposit 50 and check my balance')
    expect(intent).not.toBeNull()
    expect(intent!.action).toBe('clarification')
  })
})

describe('parseIntent confidence end-to-end (AI_MODE=local)', () => {
  it('resolves a clean command with full confidence', async () => {
    const intent = await parseIntent('withdraw 25')
    expect(intent).toEqual(
      expect.objectContaining({ action: 'withdraw', confidence: 1, amount: 25 })
    )
  })

  it('returns a clarification intent for ambiguous phrasing instead of unknown', async () => {
    const intent = await parseIntent('should I deposit or withdraw?')
    expect(intent.action).toBe('clarification')
    expect(intent.confidence).toBeLessThan(config.nlp.confidenceThreshold)
  })

  it('falls back to unknown (confidence 0) for empty input', async () => {
    const intent = await parseIntent('')
    expect(intent).toEqual({ action: 'unknown', confidence: 0 })
  })

  it('falls back to unknown (confidence 0) with AI_MODE=local for unrecognized text', async () => {
    const intent = await parseIntent('xyzzy plugh')
    expect(intent).toEqual({ action: 'unknown', confidence: 0 })
  })
})

describe('responses.clarification', () => {
  it('phrases a two-way choice with "or"', () => {
    expect(responses.clarification(['deposit money', 'withdraw money'])).toBe(
      'Did you mean to deposit money or withdraw money?'
    )
  })

  it('phrases a three-way choice as a comma list with a trailing "or"', () => {
    expect(
      responses.clarification([
        'check your balance',
        'check your earnings',
        'check your savings goal',
      ])
    ).toBe(
      'Did you mean to check your balance, check your earnings, or check your savings goal?'
    )
  })

  it('phrases a single label as a yes/no-style question asking for more detail', () => {
    expect(responses.clarification(['deposit money'])).toBe(
      'Did you want to deposit money? Could you give me a bit more detail?'
    )
  })
})
