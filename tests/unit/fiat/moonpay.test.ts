// #290 — MoonPay provider unit tests: webhook signature verification, status
// normalization, and payload parsing. No network calls are exercised here.
import { createHmac } from 'crypto'
import { MoonPayProvider } from '../../../src/fiat/providers/moonpay'

jest.mock('../../../src/utils/logger', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}))

const WEBHOOK_KEY = 'whsec_test_key'

function sign(rawBody: string, timestamp: string, key = WEBHOOK_KEY): string {
  const sig = createHmac('sha256', key)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex')
  return `t=${timestamp},s=${sig}`
}

describe('MoonPayProvider.verifyWebhookSignature', () => {
  const provider = new MoonPayProvider({ webhookKey: WEBHOOK_KEY })

  it('accepts a correctly signed payload', () => {
    const body = JSON.stringify({
      type: 'transaction_updated',
      data: { id: 'mp_1', status: 'completed' },
    })
    const ts = '1700000000'
    const header = sign(body, ts)
    expect(
      provider.verifyWebhookSignature(body, { 'moonpay-signature-v2': header })
    ).toBe(true)
  })

  it('rejects a tampered body', () => {
    const body = JSON.stringify({ data: { id: 'mp_1', status: 'completed' } })
    const ts = '1700000000'
    const header = sign(body, ts)
    const tampered = JSON.stringify({
      data: { id: 'mp_1', status: 'refunded' },
    })
    expect(
      provider.verifyWebhookSignature(tampered, {
        'moonpay-signature-v2': header,
      })
    ).toBe(false)
  })

  it('rejects a signature made with the wrong key', () => {
    const body = JSON.stringify({ data: { id: 'mp_1' } })
    const header = sign(body, '1700000000', 'wrong_key')
    expect(
      provider.verifyWebhookSignature(body, { 'moonpay-signature-v2': header })
    ).toBe(false)
  })

  it('rejects when the signature header is missing or malformed', () => {
    const body = '{}'
    expect(provider.verifyWebhookSignature(body, {})).toBe(false)
    expect(
      provider.verifyWebhookSignature(body, {
        'moonpay-signature-v2': 'garbage',
      })
    ).toBe(false)
    expect(
      provider.verifyWebhookSignature(body, { 'moonpay-signature-v2': 't=1' })
    ).toBe(false)
  })

  it('rejects everything when no webhook key is configured', () => {
    const noKey = new MoonPayProvider({ webhookKey: '' })
    const body = '{}'
    const header = sign(body, '1700000000', '')
    expect(
      noKey.verifyWebhookSignature(body, { 'moonpay-signature-v2': header })
    ).toBe(false)
  })
})

describe('MoonPayProvider.parseWebhookPayload', () => {
  const provider = new MoonPayProvider({ webhookKey: WEBHOOK_KEY })

  it('normalizes a completed transaction to SETTLED and extracts the tx hash', () => {
    const body = JSON.stringify({
      type: 'transaction_updated',
      data: {
        id: 'mp_42',
        status: 'completed',
        cryptoTransactionId: '0xabc',
        quoteCurrencyAmount: 98.5,
      },
    })
    const parsed = provider.parseWebhookPayload(body)
    expect(parsed).toMatchObject({
      providerOrderId: 'mp_42',
      status: 'SETTLED',
      txHash: '0xabc',
      cryptoAmount: 98.5,
    })
  })

  it('maps waitingPayment to PENDING', () => {
    const body = JSON.stringify({
      data: { id: 'mp_1', status: 'waitingPayment' },
    })
    expect(provider.parseWebhookPayload(body).status).toBe('PENDING')
  })

  it('maps failed to FAILED and carries the reason', () => {
    const body = JSON.stringify({
      data: { id: 'mp_1', status: 'failed', failureReason: 'card_declined' },
    })
    const parsed = provider.parseWebhookPayload(body)
    expect(parsed.status).toBe('FAILED')
    expect(parsed.reason).toBe('card_declined')
  })

  it('maps refunded/chargedback to REFUNDED', () => {
    expect(
      provider.parseWebhookPayload(
        JSON.stringify({ data: { id: 'a', status: 'refunded' } })
      ).status
    ).toBe('REFUNDED')
    expect(
      provider.parseWebhookPayload(
        JSON.stringify({ data: { id: 'b', status: 'chargedback' } })
      ).status
    ).toBe('REFUNDED')
  })

  it('flags KYC_REQUIRED when a kyc redirect url is present and not yet settled', () => {
    const body = JSON.stringify({
      data: { id: 'mp_1', status: 'pending', kycRedirectUrl: 'https://kyc' },
    })
    const parsed = provider.parseWebhookPayload(body)
    expect(parsed.status).toBe('KYC_REQUIRED')
    expect(parsed.kycUrl).toBe('https://kyc')
  })
})
