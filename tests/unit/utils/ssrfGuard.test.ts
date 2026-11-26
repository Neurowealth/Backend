import dns from 'node:dns'
import {
  validateSsrfUrl,
  isPrivateOrReservedIp,
  parseIpAddress,
  safeWebhookFetch,
} from '../../../src/utils/ssrfGuard'

jest.mock('node:dns', () => ({
  promises: {
    lookup: jest.fn(),
  },
}))

describe('SSRF Protection Guard', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    global.fetch = jest.fn()
  })

  describe('Direct IP checks', () => {
    it('rejects cloud metadata IP https://169.254.169.254/', async () => {
      await expect(validateSsrfUrl('https://169.254.169.254/')).rejects.toThrow(
        /resolves to a private or loopback range/
      )
    })

    it('rejects IPv6 loopback https://[::1]/', async () => {
      await expect(validateSsrfUrl('https://[::1]/')).rejects.toThrow(
        /resolves to a private or loopback range/
      )
    })

    it('rejects 0.0.0.0', async () => {
      await expect(validateSsrfUrl('https://0.0.0.0/')).rejects.toThrow(
        /resolves to a private or loopback range/
      )
    })

    it('rejects CGNAT range (100.64.0.0/10)', async () => {
      await expect(validateSsrfUrl('https://100.64.0.1/')).rejects.toThrow(
        /resolves to a private or loopback range/
      )
      await expect(validateSsrfUrl('https://100.127.255.254/')).rejects.toThrow(
        /resolves to a private or loopback range/
      )
    })

    it('rejects IPv4-mapped IPv6 ranges (::ffff:127.0.0.1)', async () => {
      await expect(
        validateSsrfUrl('https://[::ffff:127.0.0.1]/')
      ).rejects.toThrow(/resolves to a private or loopback range/)
    })

    it('rejects IPv6 Unique Local Addresses (fc00::/7)', async () => {
      await expect(validateSsrfUrl('https://[fd12:3456:789a::1]/')).rejects.toThrow(
        /resolves to a private or loopback range/
      )
    })

    it('rejects decimal and octal alternative IP representations', async () => {
      // 2130706433 is 127.0.0.1 in decimal notation
      await expect(validateSsrfUrl('https://2130706433/')).rejects.toThrow(
        /resolves to a private or loopback range/
      )
      // 0177.0.0.1 is 127.0.0.1 in octal notation
      await expect(validateSsrfUrl('https://0177.0.0.1/')).rejects.toThrow(
        /resolves to a private or loopback range/
      )
    })

    it('rejects non-https URLs', async () => {
      await expect(validateSsrfUrl('http://example.com/webhook')).rejects.toThrow(
        /Webhook URL must use the https:\/\/ protocol/
      )
    })
  })

  describe('DNS Resolution checks', () => {
    it('rejects a hostname that resolves to 10.0.0.1', async () => {
      ;(dns.promises.lookup as jest.Mock).mockResolvedValueOnce([
        { address: '10.0.0.1', family: 4 },
      ])

      await expect(
        validateSsrfUrl('https://internal.corp.example.com/webhook')
      ).rejects.toThrow(
        /resolves to a private or loopback range: 10\.0\.0\.1/
      )

      expect(dns.promises.lookup).toHaveBeenCalledWith(
        'internal.corp.example.com',
        { all: true }
      )
    })

    it('rejects if ANY resolved address is in a private range (dual-stack / multi-homed)', async () => {
      ;(dns.promises.lookup as jest.Mock).mockResolvedValueOnce([
        { address: '93.184.216.34', family: 4 },
        { address: '192.168.1.1', family: 4 },
      ])

      await expect(
        validateSsrfUrl('https://mixed-resolution.example.com/webhook')
      ).rejects.toThrow(/resolves to a private or loopback range: 192\.168\.1\.1/)
    })

    it('accepts public hostnames resolving to valid public IPs and pins destination', async () => {
      ;(dns.promises.lookup as jest.Mock).mockResolvedValueOnce([
        { address: '93.184.216.34', family: 4 },
      ])

      const result = await validateSsrfUrl('https://api.example.com/hook')
      expect(result.hostname).toBe('api.example.com')
      expect(result.pinnedIp).toBe('93.184.216.34')
      expect(result.resolvedIps).toEqual(['93.184.216.34'])
    })
  })

  describe('Redirect blocking with redirect: manual', () => {
    it('rejects a 302 to http://127.0.0.1', async () => {
      ;(dns.promises.lookup as jest.Mock).mockResolvedValue([
        { address: '93.184.216.34', family: 4 },
      ])

      ;(global.fetch as jest.Mock).mockResolvedValue({
        status: 302,
        headers: {
          get: (name: string) =>
            name.toLowerCase() === 'location' ? 'http://127.0.0.1/admin' : null,
        },
      })

      await expect(
        safeWebhookFetch('https://public.example.com/redirect', {
          method: 'POST',
          body: JSON.stringify({ event: 'ping' }),
        })
      ).rejects.toThrow(/SSRF: redirect from webhook destination is not allowed/)

      // Verify fetch was called with redirect: 'manual'
      expect(global.fetch).toHaveBeenCalledWith(
        'https://public.example.com/redirect',
        expect.objectContaining({
          redirect: 'manual',
        })
      )
    })

    it('allows successful 200 delivery to public destination', async () => {
      ;(dns.promises.lookup as jest.Mock).mockResolvedValue([
        { address: '93.184.216.34', family: 4 },
      ])

      ;(global.fetch as jest.Mock).mockResolvedValue({
        status: 200,
        ok: true,
      })

      const res = await safeWebhookFetch('https://public.example.com/webhook', {
        method: 'POST',
        body: JSON.stringify({ event: 'ping' }),
      })

      expect(res.status).toBe(200)
    })
  })
})
