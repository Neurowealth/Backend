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
const fetchMock = jest.fn()

global.fetch = fetchMock

beforeEach(() => {
  fetchMock.mockReset()
})

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
    const ts = String(Math.floor(Date.now() / 1000))
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

  it('rejects correctly signed timestamps outside the replay window', () => {
    const body = JSON.stringify({ data: { id: 'mp_1', status: 'completed' } })
    const staleHeader = sign(body, String(Math.floor(Date.now() / 1000) - 301))
    const futureHeader = sign(body, String(Math.floor(Date.now() / 1000) + 301))

    expect(
      provider.verifyWebhookSignature(body, {
        'moonpay-signature-v2': staleHeader,
      })
    ).toBe(false)
    expect(
      provider.verifyWebhookSignature(body, {
        'moonpay-signature-v2': futureHeader,
      })
    ).toBe(false)
  })

  it('rejects a malformed timestamp even when its HMAC is valid', () => {
    const body = '{}'
    const header = sign(body, 'not-a-timestamp')
    expect(
      provider.verifyWebhookSignature(body, {
        'moonpay-signature-v2': header,
      })
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

describe('MoonPayProvider sell requests (#829)', () => {
  const provider = new MoonPayProvider({
    apiKey: 'test-api-key',
    secretKey: 'test-secret-key',
    baseUrl: 'https://moonpay.test',
  })

  it('uses sell-side quote parameters and returns the crypto base amount', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        quoteCurrencyAmount: 250,
        baseCurrencyAmount: 1.5,
      }),
    })

    const quote = await provider.getQuote({
      direction: 'OFF_RAMP',
      fiatAmount: 1.5,
      fiatCurrency: 'USD',
      assetSymbol: 'XLM',
    })

    expect(fetchMock.mock.calls[0][0]).toContain('/sell_quote?')
    expect(fetchMock.mock.calls[0][0]).toContain('quoteCurrencyCode=usd')
    expect(fetchMock.mock.calls[0][0]).toContain('baseCurrencyAmount=1.5')
    expect(fetchMock.mock.calls[0][0]).not.toContain('baseCurrencyCode=usd')
    expect(quote.cryptoAmount).toBe(1.5)
  })

  it('uses sell-side order parameters and returns the crypto base amount', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'moonpay-order-1', baseCurrencyAmount: 1.5 }),
    })

    const order = await provider.createOrder({
      userId: 'user-1',
      direction: 'OFF_RAMP',
      fiatAmount: 1.5,
      fiatCurrency: 'USD',
      assetSymbol: 'XLM',
      walletAddress: 'GTEST',
    })

    const request = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(request).toMatchObject({
      flow: 'sell',
      currencyCode: 'xlm',
      quoteCurrencyCode: 'usd',
      baseCurrencyAmount: 1.5,
    })
    expect(request.baseCurrencyCode).toBeUndefined()
    expect(order.cryptoAmount).toBe(1.5)
  })
})
