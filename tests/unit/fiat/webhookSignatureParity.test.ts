/**
 * Shared adversarial webhook-signature test harness (#607).
 *
 * The point of this file is parity: every FiatRampProvider that verifies
 * webhook signatures runs the SAME battery of adversarial tests here, so a
 * new provider cannot ship with a weaker verifier by accident. Provider-
 * specific signature tests (e.g. header format, timestamp window) still live
 * in each provider's own test file; this file guards the floor.
 *
 * To onboard a new provider, add a `ProviderCase` to CASES below. The battery
 * reads the `signValid` function to produce a correctly signed payload; every
 * adversarial variant is derived from that one valid signature.
 */

import { createHmac } from 'crypto'
import { MoonPayProvider } from '../../../src/fiat/providers/moonpay'
import { TransakProvider } from '../../../src/fiat/providers/transak'
import type { FiatRampProvider } from '../../../src/fiat/types'

jest.mock('../../../src/utils/logger', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}))

interface ProviderCase {
  name: string
  /** Fresh provider configured with the shared test secret. */
  configured: () => FiatRampProvider
  /** Same provider with no signing secret configured. */
  unconfigured: () => FiatRampProvider
  /** Produce headers that pass verification against the configured provider. */
  signValid: (rawBody: string) => Record<string, string>
}

const SHARED_SECRET = 'whsec_shared_test_secret'

const CASES: ProviderCase[] = [
  {
    name: 'moonpay',
    configured: () => new MoonPayProvider({ webhookKey: SHARED_SECRET }),
    unconfigured: () => new MoonPayProvider({ webhookKey: '' }),
    signValid: (rawBody: string) => {
      const t = String(Math.floor(Date.now() / 1000))
      const sig = createHmac('sha256', SHARED_SECRET)
        .update(`${t}.${rawBody}`)
        .digest('hex')
      return { 'moonpay-signature-v2': `t=${t},s=${sig}` }
    },
  },
  {
    name: 'transak',
    configured: () =>
      new TransakProvider({ apiSecret: '', webhookSecret: SHARED_SECRET }),
    unconfigured: () =>
      new TransakProvider({ apiSecret: '', webhookSecret: '' }),
    signValid: (rawBody: string) => {
      const sig = createHmac('sha256', SHARED_SECRET)
        .update(rawBody)
        .digest('hex')
      return { 'x-transak-signature': sig }
    },
  },
]

describe.each(CASES)(
  'FiatRampProvider webhook signature parity: $name',
  (c) => {
    const body = JSON.stringify({
      id: 'parity_1',
      status: 'completed',
      data: { nested: true, amount: '100' },
    })

    it('accepts a correctly signed payload', () => {
      const p = c.configured()
      expect(p.verifyWebhookSignature(body, c.signValid(body))).toBe(true)
    })

    it('rejects when the secret is unconfigured — never trusts an unverifiable payload', () => {
      const p = c.unconfigured()
      // Even with a header that would be valid under a shared secret, an
      // unconfigured provider must refuse to verify.
      expect(p.verifyWebhookSignature(body, c.signValid(body))).toBe(false)
    })

    it('rejects a tampered body with the original signature', () => {
      const p = c.configured()
      const headers = c.signValid(body)
      const tampered = body.replace('"100"', '"999999"')
      expect(p.verifyWebhookSignature(tampered, headers)).toBe(false)
    })

    it('rejects a signature made with the wrong key', () => {
      const p = c.configured()
      const wrongKey = 'different_secret'
      const wrongHeaders =
        c.name === 'moonpay'
          ? {
              'moonpay-signature-v2': (() => {
                const t = String(Math.floor(Date.now() / 1000))
                const sig = createHmac('sha256', wrongKey)
                  .update(`${t}.${body}`)
                  .digest('hex')
                return `t=${t},s=${sig}`
              })(),
            }
          : {
              'x-transak-signature': createHmac('sha256', wrongKey)
                .update(body)
                .digest('hex'),
            }
      expect(p.verifyWebhookSignature(body, wrongHeaders)).toBe(false)
    })

    it('rejects when the signature header is missing', () => {
      const p = c.configured()
      expect(p.verifyWebhookSignature(body, {})).toBe(false)
    })

    it('rejects when the signature header is garbage', () => {
      const p = c.configured()
      const headers =
        c.name === 'moonpay'
          ? { 'moonpay-signature-v2': 'not-a-signature' }
          : { 'x-transak-signature': 'deadbeef' }
      expect(p.verifyWebhookSignature(body, headers)).toBe(false)
    })

    it('is deterministic: identical input returns identical verdict', () => {
      const p = c.configured()
      const headers = c.signValid(body)
      const first = p.verifyWebhookSignature(body, headers)
      const second = p.verifyWebhookSignature(body, headers)
      expect(first).toBe(second)
    })
  }
)
