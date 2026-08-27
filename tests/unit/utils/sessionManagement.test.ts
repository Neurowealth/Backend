import { parseDeviceType } from '../../../src/utils/deviceType'
import { maskIpAddress, resolveApproxLocation } from '../../../src/utils/geoip'
import {
  createSessionDeepLinkToken,
  verifySessionDeepLinkToken,
} from '../../../src/utils/sessionDeepLink'

describe('Session utilities (#376)', () => {
  describe('parseDeviceType', () => {
    it('detects iOS', () => {
      expect(parseDeviceType('Mozilla/5.0 (iPhone)')).toBe('ios')
    })

    it('detects CLI tools', () => {
      expect(parseDeviceType('curl/7.68.0')).toBe('cli')
    })

    it('returns unknown for empty UA', () => {
      expect(parseDeviceType(null)).toBe('unknown')
    })
  })

  describe('geoip', () => {
    it('masks IPv4 last octet', () => {
      expect(maskIpAddress('203.0.113.50')).toBe('203.0.113.xxx')
    })

    it('returns null for private IPs', () => {
      expect(resolveApproxLocation('127.0.0.1')).toBeNull()
      expect(resolveApproxLocation('192.168.1.1')).toBeNull()
    })
  })

  describe('sessionDeepLink', () => {
    it('creates and verifies a deep link token', () => {
      const token = createSessionDeepLinkToken('user-1', 'session-1')
      const result = verifySessionDeepLinkToken(token)
      expect(result).toEqual({ userId: 'user-1', sessionId: 'session-1' })
    })

    it('rejects tampered tokens', () => {
      expect(verifySessionDeepLinkToken('invalid')).toBeNull()
    })
  })
})
