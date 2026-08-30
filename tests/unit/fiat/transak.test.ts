// #399 — Transak provider unit tests: webhook signature verification, status
// normalization, and payload parsing. No network calls are exercised here.
import { createHmac } from 'crypto'
import { TransakProvider } from '../../../src/fiat/providers/transak'

jest.mock('../../../src/utils/logger', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}))

const WEBHOOK_SECRET = 'whsec_test_key'

function sign(rawBody: string, key = WEBHOOK_SECRET): string {
  return createHmac('sha256', key).update(rawBody).digest('hex')
}

describe('TransakProvider.verifyWebhookSignature', () => {
  it('accepts a correctly signed payload', () => {
    const body = JSON.stringify({
      id: 'abc_1',
      status: 'SUCCESS_COMPLETED',
    })
    const header = sign(body)
    expect(
      provider().verifyWebhookSignature(body, { 'x-transak-signature': header })
    ).toBe(true)
  })

  it('accepts the account API secret as the signing key when no webhook secret is set', () => {
    const providerWithApiSecret = new TransakProvider({
      apiSecret: 'account_secret',
      webhookSecret: '',
    })
    const body = JSON.stringify({ id: 'abc_1', status: 'PENDING' })
    const header = sign(body, 'account_secret')
    expect(
      providerWithApiSecret.verifyWebhookSignature(body, {
        'x-transak-signature': header,
      })
    ).toBe(true)
  })

  it('rejects a tampered body', () => {
    const body = JSON.stringify({ id: 'abc_1', status: 'PENDING' })
    const header = sign(body)
    const tampered = JSON.stringify({ id: 'abc_1', status: 'FAILED' })
    expect(
      provider().verifyWebhookSignature(tampered, {
        'x-transak-signature': header,
      })
    ).toBe(false)
  })

  it('rejects a signature made with the wrong key', () => {
    const body = JSON.stringify({ id: 'abc_1' })
    const header = sign(body, 'wrong_key')
    expect(
      provider().verifyWebhookSignature(body, { 'x-transak-signature': header })
    ).toBe(false)
  })

  it('rejects when the signature header is missing or malformed', () => {
    const body = '{}'
    expect(provider().verifyWebhookSignature(body, {})).toBe(false)
    expect(
      provider().verifyWebhookSignature(body, {
        'x-transak-signature': 'garbage$$$',
      })
    ).toBe(false)
  })

  it('rejects everything when no signing key is configured', () => {
    const noKey = new TransakProvider({ apiSecret: '', webhookSecret: '' })
    const body = '{}'
    const header = sign(body, '')
    expect(
      noKey.verifyWebhookSignature(body, { 'x-transak-signature': header })
    ).toBe(false)
  })
})

describe('TransakProvider.parseWebhookPayload', () => {
  it('normalizes a completed order to SETTLED and extracts the tx hash', () => {
    const body = JSON.stringify({
      id: 'tsk_42',
      status: 'SUCCESS_COMPLETED',
      hash: '0xabc',
      cryptoAmount: 98.5,
    })
    const parsed = provider().parseWebhookPayload(body)
    expect(parsed).toMatchObject({
      providerOrderId: 'tsk_42',
      status: 'SETTLED',
      txHash: '0xabc',
      cryptoAmount: 98.5,
    })
  })

  it('maps AWAITING_PAYMENT_FROM_USER to PENDING', () => {
    const body = JSON.stringify({
      id: 'tsk_1',
      status: 'AWAITING_PAYMENT_FROM_USER',
    })
    expect(provider().parseWebhookPayload(body).status).toBe('PENDING')
  })

  it('maps PAYMENT_DONE and IN_PROGRESS to PROCESSING', () => {
    expect(
      provider().parseWebhookPayload(
        JSON.stringify({ id: 'a', status: 'PAYMENT_DONE' })
      ).status
    ).toBe('PROCESSING')
    expect(
      provider().parseWebhookPayload(
        JSON.stringify({ id: 'b', status: 'IN_PROGRESS' })
      ).status
    ).toBe('PROCESSING')
  })

  it('maps FAILED to FAILED and carries the reason', () => {
    const body = JSON.stringify({
      id: 'tsk_1',
      status: 'FAILED',
      statusReason: 'card_declined',
    })
    const parsed = provider().parseWebhookPayload(body)
    expect(parsed.status).toBe('FAILED')
    expect(parsed.reason).toBe('card_declined')
  })

  it('maps EXPIRED and CANCELLED to FAILED', () => {
    expect(
      provider().parseWebhookPayload(
        JSON.stringify({ id: 'a', status: 'EXPIRED' })
      ).status
    ).toBe('FAILED')
    expect(
      provider().parseWebhookPayload(
        JSON.stringify({ id: 'b', status: 'CANCELLED' })
      ).status
    ).toBe('FAILED')
  })

  it('maps REFUNDED to REFUNDED', () => {
    expect(
      provider().parseWebhookPayload(
        JSON.stringify({ id: 'a', status: 'REFUNDED' })
      ).status
    ).toBe('REFUNDED')
  })

  it('maps ON_HOLD_FOR_KYC to KYC_REQUIRED', () => {
    const body = JSON.stringify({
      id: 'tsk_1',
      status: 'ON_HOLD_FOR_KYC',
      kycUrl: 'https://kyc.transak.com',
    })
    const parsed = provider().parseWebhookPayload(body)
    expect(parsed.status).toBe('KYC_REQUIRED')
    expect(parsed.kycUrl).toBe('https://kyc.transak.com')
  })

  it('reads the order id from a wrapped data envelope', () => {
    const body = JSON.stringify({
      data: { id: 'tsk_7', status: 'PENDING' },
    })
    expect(provider().parseWebhookPayload(body).providerOrderId).toBe('tsk_7')
  })
})

function provider(): TransakProvider {
  return new TransakProvider({
    webhookSecret: WEBHOOK_SECRET,
    apiSecret: 'account_secret',
  })
}
