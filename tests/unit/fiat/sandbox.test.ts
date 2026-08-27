// #313 — Sandbox provider: the second concrete FiatRampProvider implementation
// proving the multi-provider abstraction works end-to-end. Deterministic, no
// network calls.
import { createHmac } from 'crypto'
import { SandboxProvider } from '../../../src/fiat/providers/sandbox'

jest.mock('../../../src/utils/logger', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}))

const WEBHOOK_KEY = 'sandbox_test_key'

function sign(rawBody: string, key = WEBHOOK_KEY): string {
  return `sha256=${createHmac('sha256', key).update(rawBody).digest('hex')}`
}

describe('SandboxProvider.getQuote', () => {
  const provider = new SandboxProvider({ webhookKey: WEBHOOK_KEY })

  it('returns a structured fee breakdown, never assuming zero', async () => {
    const quote = await provider.getQuote({
      direction: 'ON_RAMP',
      fiatAmount: 100,
      fiatCurrency: 'USD',
      assetSymbol: 'USDC',
    })

    expect(quote.provider).toBe('sandbox')
    expect(quote.unpriced).toBe(false)
    expect(quote.fees).not.toBeNull()
    expect(quote.fees!.providerFee).toBeGreaterThan(0)
    expect(quote.cryptoAmount).toBeGreaterThan(0)
  })

  it('quotes less crypto for ON_RAMP than the gross fiat amount would imply (fees deducted)', async () => {
    const quote = await provider.getQuote({
      direction: 'ON_RAMP',
      fiatAmount: 100,
      fiatCurrency: 'USD',
      assetSymbol: 'USDC',
    })
    // USDC rate is 1:1 before fees, so cryptoAmount should be < 100.
    expect(quote.cryptoAmount).toBeLessThan(100)
  })

  it('flags requiresKyc above the configured threshold, not below it', async () => {
    const small = await provider.getQuote({
      direction: 'ON_RAMP',
      fiatAmount: 500,
      fiatCurrency: 'USD',
      assetSymbol: 'USDC',
    })
    const large = await provider.getQuote({
      direction: 'ON_RAMP',
      fiatAmount: 5000,
      fiatCurrency: 'USD',
      assetSymbol: 'USDC',
    })
    expect(small.requiresKyc).toBe(false)
    expect(large.requiresKyc).toBe(true)
  })
})

describe('SandboxProvider.createOrder', () => {
  const provider = new SandboxProvider({ webhookKey: WEBHOOK_KEY })

  it('returns a checkout URL and PENDING status below the KYC threshold', async () => {
    const result = await provider.createOrder({
      userId: 'user-1',
      direction: 'ON_RAMP',
      fiatAmount: 100,
      fiatCurrency: 'USD',
      assetSymbol: 'USDC',
      walletAddress: 'GWALLET',
    })
    expect(result.status).toBe('PENDING')
    expect(result.checkoutUrl).toContain(result.providerOrderId)
    expect(result.kycUrl).toBeUndefined()
  })

  it('gates large orders behind KYC_REQUIRED with a kycUrl', async () => {
    const result = await provider.createOrder({
      userId: 'user-1',
      direction: 'ON_RAMP',
      fiatAmount: 5000,
      fiatCurrency: 'USD',
      assetSymbol: 'USDC',
      walletAddress: 'GWALLET',
    })
    expect(result.status).toBe('KYC_REQUIRED')
    expect(result.kycUrl).toBeDefined()
  })
})

describe('SandboxProvider webhook verification + parsing', () => {
  const provider = new SandboxProvider({ webhookKey: WEBHOOK_KEY })

  it('accepts a correctly signed payload', () => {
    const body = JSON.stringify({
      providerOrderId: 'sandbox_1',
      status: 'SETTLED',
    })
    const header = sign(body)
    expect(
      provider.verifyWebhookSignature(body, { 'x-sandbox-signature': header })
    ).toBe(true)
  })

  it('rejects a tampered body', () => {
    const body = JSON.stringify({
      providerOrderId: 'sandbox_1',
      status: 'SETTLED',
    })
    const header = sign(body)
    const tampered = JSON.stringify({
      providerOrderId: 'sandbox_1',
      status: 'FAILED',
    })
    expect(
      provider.verifyWebhookSignature(tampered, {
        'x-sandbox-signature': header,
      })
    ).toBe(false)
  })

  it('rejects when no webhook key is configured', () => {
    const noKeyProvider = new SandboxProvider({ webhookKey: '' })
    const body = JSON.stringify({
      providerOrderId: 'sandbox_1',
      status: 'SETTLED',
    })
    expect(
      noKeyProvider.verifyWebhookSignature(body, {
        'x-sandbox-signature': sign(body),
      })
    ).toBe(false)
  })

  it('parses a webhook payload into the normalized shape', () => {
    const body = JSON.stringify({
      providerOrderId: 'sandbox_1',
      status: 'PROCESSING',
      txHash: '0xabc',
      cryptoAmount: 98.5,
    })
    const parsed = provider.parseWebhookPayload(body)
    expect(parsed).toEqual({
      providerOrderId: 'sandbox_1',
      status: 'PROCESSING',
      txHash: '0xabc',
      cryptoAmount: 98.5,
      kycUrl: undefined,
      reason: undefined,
    })
  })
})
