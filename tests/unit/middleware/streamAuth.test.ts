import crypto from 'node:crypto'
import {
  createStreamTicket,
  verifyStreamTicket,
} from '../../../src/middleware/streamAuth'

describe('streamAuth (#369)', () => {
  it('creates and verifies a valid stream ticket', () => {
    const ticket = createStreamTicket('user_123', 'user_123', [
      'portfolio',
      'agent',
    ])
    expect(typeof ticket).toBe('string')

    const verified = verifyStreamTicket(ticket)
    expect(verified).not.toBeNull()
    expect(verified?.viewerUserId).toBe('user_123')
    expect(verified?.streamUserId).toBe('user_123')
    expect(verified?.allowedTopics).toEqual(['portfolio', 'agent'])
  })

  it('enforces single-use stream ticket policy (rejects replay)', () => {
    const ticket = createStreamTicket('user_456')

    const firstUse = verifyStreamTicket(ticket)
    expect(firstUse).not.toBeNull()

    const secondUse = verifyStreamTicket(ticket)
    expect(secondUse).toBeNull()
  })

  it('rejects tampered stream tickets', () => {
    const ticket = createStreamTicket('user_789')
    const tampered = `${ticket}extra`

    expect(verifyStreamTicket(tampered)).toBeNull()
    expect(verifyStreamTicket('invalid.token.string')).toBeNull()
  })

  it('rejects tickets signed with the former hardcoded fallback secret', () => {
    const payload = {
      ticketId: crypto.randomUUID(),
      viewerUserId: 'user_legacy',
      streamUserId: 'user_legacy',
      allowedTopics: ['portfolio'],
      exp: Math.floor(Date.now() / 1000) + 60,
    }
    const payloadStr = JSON.stringify(payload)
    const signature = crypto
      .createHmac('sha256', 'neuro-stream-ticket-secret-key-32b')
      .update(payloadStr)
      .digest('base64url')
    const oldTicket = `${Buffer.from(payloadStr).toString('base64url')}.${signature}`

    expect(verifyStreamTicket(oldTicket)).toBeNull()
  })
})
