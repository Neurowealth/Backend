import {
  generateUnsubscribeToken,
  verifyUnsubscribeToken,
} from '../../src/notifications/service'

describe('unsubscribe tokens', () => {
  beforeEach(() => {
    process.env.UNSUBSCRIBE_TOKEN_SECRET =
      'test-secret-that-is-long-enough-for-hmac'
  })

  afterEach(() => {
    delete process.env.UNSUBSCRIBE_TOKEN_SECRET
  })

  it('rejects a token forged with a different user id', () => {
    const token = generateUnsubscribeToken('user-a')

    expect(verifyUnsubscribeToken(token, 'user-a')).toBe(true)
    expect(verifyUnsubscribeToken(token, 'user-b')).toBe(false)
  })
})
