import {
  signPayloadV2,
  verifyPayloadV2,
  buildSignatureHeader,
  generateWebhookSecret,
} from '../../../src/utils/webhookSignature'
import {
  isSubscriptionDeliverable,
  recordDeliveryFailure,
  recordDeliverySuccess,
  _clearAllHealth,
} from '../../../src/services/webhookCircuitBreaker'

describe('Webhook hardening (#377)', () => {
  beforeEach(() => {
    _clearAllHealth()
  })

  describe('signature v2', () => {
    it('signs timestamp.deliveryId.body', () => {
      const secret = generateWebhookSecret()
      const sig = signPayloadV2(secret, 1700000000, 'del-1', '{"event":"test"}')
      expect(sig).toHaveLength(64)
    })

    it('verifies valid v2 signatures within tolerance', () => {
      const secret = generateWebhookSecret()
      const ts = Math.floor(Date.now() / 1000)
      const body = '{"event":"test"}'
      const sig = signPayloadV2(secret, ts, 'del-1', body)
      expect(verifyPayloadV2(secret, ts, 'del-1', body, sig)).toBe(true)
    })

    it('builds combined v1+v2 header', () => {
      const secret = generateWebhookSecret()
      const header = buildSignatureHeader(
        [secret],
        '{"a":1}',
        1700000000,
        'del-1'
      )
      expect(header).toContain('v2,')
      expect(header).toContain('v1,')
    })
  })

  describe('circuit breaker', () => {
    it('starts closed and opens after threshold failures', () => {
      const id = 'sub-1'
      expect(isSubscriptionDeliverable(id)).toBe(true)

      for (let i = 0; i < 5; i++) {
        recordDeliveryFailure(id)
      }
      expect(isSubscriptionDeliverable(id)).toBe(false)
    })

    it('closes on success', () => {
      const id = 'sub-2'
      recordDeliveryFailure(id)
      recordDeliverySuccess(id)
      expect(isSubscriptionDeliverable(id)).toBe(true)
    })
  })
})
