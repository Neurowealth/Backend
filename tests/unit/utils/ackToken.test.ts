import crypto from 'node:crypto'
import { signAckToken, verifyAckToken } from '../../../src/utils/ackToken'

describe('ackToken (#366)', () => {
  it('signs and verifies an ackToken correctly', () => {
    const token = signAckToken('rule_123', 'fire_456', 'user_789')
    expect(typeof token).toBe('string')

    const verified = verifyAckToken(token)
    expect(verified).not.toBeNull()
    expect(verified?.ruleId).toBe('rule_123')
    expect(verified?.fireId).toBe('fire_456')
    expect(verified?.userId).toBe('user_789')
  })

  it('allows repeated verification without process-local replay state', () => {
    const token = signAckToken('rule_123', 'fire_456', 'user_789')

    const first = verifyAckToken(token)
    const second = verifyAckToken(token)

    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(first?.fireId).toBe(second?.fireId)
  })

  it('rejects tampered ackTokens', () => {
    const token = signAckToken('rule_123', 'fire_456', 'user_789')
    expect(verifyAckToken(`${token}tampered`)).toBeNull()
  })

  it('rejects tokens signed with the former hardcoded fallback secret', () => {
    const payload = {
      ruleId: 'rule_123',
      fireId: 'fire_456',
      userId: 'user_789',
      exp: Math.floor(Date.now() / 1000) + 60,
    }
    const payloadStr = JSON.stringify(payload)
    const signature = crypto
      .createHmac('sha256', 'neuro-ack-token-secret-key-32b')
      .update(payloadStr)
      .digest('base64url')
    const oldToken = `${Buffer.from(payloadStr).toString('base64url')}.${signature}`

    expect(verifyAckToken(oldToken)).toBeNull()
  })
})
