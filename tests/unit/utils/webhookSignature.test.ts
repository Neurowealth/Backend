import { createHmac } from 'crypto'
import {
  generateWebhookSecret,
  signPayload,
} from '../../../src/utils/webhookSignature'

describe('webhookSignature', () => {
  describe('generateWebhookSecret', () => {
    it('returns a 64-character hex string', () => {
      const secret = generateWebhookSecret()
      expect(secret).toMatch(/^[0-9a-f]{64}$/)
    })

    it('returns a unique value each call', () => {
      expect(generateWebhookSecret()).not.toBe(generateWebhookSecret())
    })
  })

  describe('signPayload', () => {
    const secret = 'test-secret'
    const payload = JSON.stringify({
      event: 'deposit.received',
      data: { amount: '100' },
    })

    it('returns a sha256= prefixed hex digest', () => {
      const sig = signPayload(secret, payload)
      expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/)
    })

    it('matches a manually computed HMAC-SHA256', () => {
      const expected = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`
      expect(signPayload(secret, payload)).toBe(expected)
    })

    it('produces different signatures for different secrets', () => {
      expect(signPayload('secret-a', payload)).not.toBe(
        signPayload('secret-b', payload)
      )
    })

    it('produces different signatures for different payloads', () => {
      expect(signPayload(secret, 'payload-a')).not.toBe(
        signPayload(secret, 'payload-b')
      )
    })

    it('is deterministic for the same inputs', () => {
      expect(signPayload(secret, payload)).toBe(signPayload(secret, payload))
    })
  })
})
