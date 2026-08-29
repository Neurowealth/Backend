import {
  validateSsrfUrl,
  signUserWebhookPayload,
  hashSecret,
} from '../../../src/services/userWebhookDispatcher'

describe('userWebhookDispatcher (#368)', () => {
  it('validates SSRF protection for public https URLs', () => {
    expect(() =>
      validateSsrfUrl('https://api.myclient.com/webhook')
    ).not.toThrow()
    expect(() =>
      validateSsrfUrl('https://hooks.slack.com/services/xxx')
    ).not.toThrow()
  })

  it('rejects HTTP URLs, local IPs, and loopback hostnames for SSRF protection', () => {
    expect(() => validateSsrfUrl('http://api.myclient.com/webhook')).toThrow(
      /must use the https:\/\/ protocol/
    )
    expect(() => validateSsrfUrl('https://localhost/webhook')).toThrow(
      /private or loopback range/
    )
    expect(() => validateSsrfUrl('https://127.0.0.1/webhook')).toThrow(
      /private or loopback range/
    )
    expect(() => validateSsrfUrl('https://10.0.0.1/webhook')).toThrow(
      /private or loopback range/
    )
    expect(() => validateSsrfUrl('https://192.168.1.50/webhook')).toThrow(
      /private or loopback range/
    )
    expect(() =>
      validateSsrfUrl('https://169.254.169.254/latest/meta-data')
    ).toThrow(/private or loopback range/)
  })

  it('signs payload with timestamp and HMAC-SHA256', () => {
    const payload = JSON.stringify({ event: 'deposit.received', amount: 100 })
    const secret = 'whsec_test_secret_key_12345'
    const timestamp = 1700000000

    const signatureHeader = signUserWebhookPayload(payload, secret, timestamp)
    expect(signatureHeader).toContain(`t=${timestamp},v1=`)

    const signatureHex = signatureHeader.split('v1=')[1]
    expect(signatureHex).toMatch(/^[a-f0-9]{64}$/)
  })

  it('hashes secrets deterministically using SHA-256', () => {
    const secret = 'whsec_sample_secret'
    const hash1 = hashSecret(secret)
    const hash2 = hashSecret(secret)

    expect(hash1).toBe(hash2)
    expect(hash1).toMatch(/^[a-f0-9]{64}$/)
  })
})
