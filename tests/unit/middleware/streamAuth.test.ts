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
})
