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

  it('returns payload for repeated verification (idempotent handling)', () => {
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
})
