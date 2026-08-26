/**
 * The confirmation gate is the load-bearing safety property of the assistant
 * (#318): an action tool must never execute without an affirmative
 * confirmation recorded against the EXACT proposal — same spirit as the
 * referral-activation test that refuses client-reported claims.
 */

import {
  clearAllPendingToolConfirmations,
  getPendingToolConfirmation,
  isAffirmativeReply,
  isNegativeReply,
  markCallExecuted,
  setPendingToolConfirmation,
  wasCallExecuted,
} from '../../../../src/agent/assistant/confirmations'

describe('assistant confirmation gate', () => {
  beforeEach(() => {
    clearAllPendingToolConfirmations()
  })

  it('a parked confirmation is retrievable by (channel, userId)', () => {
    setPendingToolConfirmation('whatsapp', 'user-1', {
      toolName: 'withdraw',
      args: { amount: 50, assetSymbol: 'USDC' },
      summary: 'Withdraw 50 USDC',
      callId: 'call-1',
    })

    const pending = getPendingToolConfirmation('whatsapp', 'user-1')
    expect(pending).not.toBeNull()
    expect(pending!.toolName).toBe('withdraw')
    expect(pending!.args).toEqual({ amount: 50, assetSymbol: 'USDC' })
  })

  it('is scoped per (channel, userId) — a confirmation for one user is invisible to another', () => {
    setPendingToolConfirmation('whatsapp', 'user-1', {
      toolName: 'withdraw',
      args: { amount: 50 },
      summary: 'Withdraw 50',
      callId: 'call-1',
    })

    expect(getPendingToolConfirmation('whatsapp', 'user-2')).toBeNull()
    expect(getPendingToolConfirmation('telegram', 'user-1')).toBeNull()
  })

  it('expires after the TTL — a stale "yes" can never resurrect a confirmation', () => {
    const start = 1_000_000
    setPendingToolConfirmation(
      'whatsapp',
      'user-1',
      {
        toolName: 'withdraw',
        args: { amount: 50 },
        summary: 'Withdraw 50',
        callId: 'call-1',
      },
      start
    )

    // Just before expiry: still live.
    expect(
      getPendingToolConfirmation('whatsapp', 'user-1', start + 4 * 60 * 1000)
    ).not.toBeNull()
    // Past expiry: gone, and evicted (not just hidden).
    expect(
      getPendingToolConfirmation('whatsapp', 'user-1', start + 6 * 60 * 1000)
    ).toBeNull()
    expect(
      getPendingToolConfirmation('whatsapp', 'user-1', start + 6 * 60 * 1000)
    ).toBeNull()
  })

  it('an ambiguous reply neither clears nor executes the pending confirmation', () => {
    setPendingToolConfirmation('whatsapp', 'user-1', {
      toolName: 'withdraw',
      args: { amount: 50 },
      summary: 'Withdraw 50',
      callId: 'call-1',
    })

    expect(isAffirmativeReply('maybe later')).toBe(false)
    expect(isNegativeReply('maybe later')).toBe(false)

    // The pending row must still be exactly what was proposed — an
    // unrecognized reply must never be treated as an implicit yes.
    const pending = getPendingToolConfirmation('whatsapp', 'user-1')
    expect(pending).not.toBeNull()
    expect(pending!.args).toEqual({ amount: 50 })
  })

  it('recognizes standard affirmative/negative phrasing', () => {
    for (const phrase of ['yes', 'Yes!', 'y', 'confirm', 'go ahead', 'ok']) {
      expect(isAffirmativeReply(phrase)).toBe(true)
    }
    for (const phrase of ['no', 'nope', 'cancel', 'never mind']) {
      expect(isNegativeReply(phrase)).toBe(true)
    }
  })

  it('clearing removes the pending confirmation so it cannot be replayed', () => {
    setPendingToolConfirmation('whatsapp', 'user-1', {
      toolName: 'withdraw',
      args: { amount: 50 },
      summary: 'Withdraw 50',
      callId: 'call-1',
    })

    const {
      clearPendingToolConfirmation,
    } = require('../../../../src/agent/assistant/confirmations')
    clearPendingToolConfirmation('whatsapp', 'user-1')

    expect(getPendingToolConfirmation('whatsapp', 'user-1')).toBeNull()
  })

  it('a confirmed call executed once is recognized as already-executed on replay (idempotency)', () => {
    expect(wasCallExecuted('call-1')).toBe(false)
    markCallExecuted('call-1')
    expect(wasCallExecuted('call-1')).toBe(true)
  })

  it('the executed-call marker also expires (does not leak forever)', () => {
    const start = 2_000_000
    markCallExecuted('call-2', start)
    expect(wasCallExecuted('call-2', start + 4 * 60 * 1000)).toBe(true)
    expect(wasCallExecuted('call-2', start + 6 * 60 * 1000)).toBe(false)
  })
})
