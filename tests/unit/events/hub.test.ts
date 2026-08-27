/**
 * #316 — in-process fan-out registry.
 *
 * The one rule worth a test: a subscriber is handed an event only when the
 * viewer identity it authenticated with is in the set the PUBLISHER authorised.
 * The hub never decides permission for itself.
 */

import {
  countLocalSubscribers,
  deliverToLocalSubscribers,
  resetHub,
  subscribeToUserStream,
} from '../../../src/events/hub'
import type { UserEventEnvelope } from '../../../src/events/types'

jest.mock('../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

function envelope(
  overrides: Partial<UserEventEnvelope> = {}
): UserEventEnvelope {
  return {
    streamUserId: 'child-1',
    authorizedViewers: ['child-1'],
    seq: 1,
    topic: 'portfolio',
    type: 'portfolio.updated',
    payload: {},
    emittedAt: '2026-08-25T00:00:00.000Z',
    originId: 'pod-1',
    ...overrides,
  }
}

afterEach(() => resetHub())

describe('event hub', () => {
  it('delivers to the stream owner', () => {
    const deliver = jest.fn()
    subscribeToUserStream({
      streamUserId: 'child-1',
      viewerUserId: 'child-1',
      deliver,
    })

    expect(deliverToLocalSubscribers(envelope())).toBe(1)
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it('withholds from a viewer the publisher did not authorise', () => {
    const deliver = jest.fn()
    subscribeToUserStream({
      streamUserId: 'child-1',
      viewerUserId: 'parent-1',
      deliver,
    })

    // Grant revoked between handshake and publish: the viewer set says no.
    expect(deliverToLocalSubscribers(envelope())).toBe(0)
    expect(deliver).not.toHaveBeenCalled()
  })

  it('delivers to a permitted parent on the child stream', () => {
    const deliver = jest.fn()
    subscribeToUserStream({
      streamUserId: 'child-1',
      viewerUserId: 'parent-1',
      deliver,
    })

    const count = deliverToLocalSubscribers(
      envelope({ authorizedViewers: ['child-1', 'parent-1'] })
    )
    expect(count).toBe(1)
  })

  it('keeps fanning out when one subscriber throws', () => {
    const good = jest.fn()
    subscribeToUserStream({
      streamUserId: 'child-1',
      viewerUserId: 'child-1',
      deliver: () => {
        throw new Error('wedged socket')
      },
    })
    subscribeToUserStream({
      streamUserId: 'child-1',
      viewerUserId: 'child-1',
      deliver: good,
    })

    expect(deliverToLocalSubscribers(envelope())).toBe(1)
    expect(good).toHaveBeenCalledTimes(1)
  })

  it('unregisters cleanly', () => {
    const unsubscribe = subscribeToUserStream({
      streamUserId: 'child-1',
      viewerUserId: 'child-1',
      deliver: jest.fn(),
    })
    expect(countLocalSubscribers()).toBe(1)
    unsubscribe()
    expect(countLocalSubscribers()).toBe(0)
    expect(deliverToLocalSubscribers(envelope())).toBe(0)
  })
})
