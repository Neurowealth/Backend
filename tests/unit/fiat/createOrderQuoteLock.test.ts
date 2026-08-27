// #313 — createFiatOrder: quote-lock consumption, expiry rejection, and
// provider-preference / default-policy fallback when no quoteId is supplied.
import db from '../../../src/db'
import {
  selectProviderForOrder,
  getProvider,
  recordProviderSuccess,
  recordProviderFailure,
} from '../../../src/fiat/registry'
import { createFiatOrder } from '../../../src/fiat/service'
import { FiatOrderError } from '../../../src/fiat/types'

jest.mock('../../../src/db', () => ({ __esModule: true, default: {} }))
jest.mock('../../../src/utils/logger', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}))
jest.mock('../../../src/fiat/registry', () => ({
  selectProviderForOrder: jest.fn(),
  getProvider: jest.fn(),
  recordProviderSuccess: jest.fn(),
  recordProviderFailure: jest.fn(),
}))
jest.mock('../../../src/utils/metrics', () => ({
  recordFiatQuoteLatency: jest.fn(),
  recordFiatQuoteFailure: jest.fn(),
  recordFiatOrder: jest.fn(),
  recordFiatRateDrift: jest.fn(),
  setFiatProviderCircuitState: jest.fn(),
}))

const mockDb = db as any
const mockSelectProvider = selectProviderForOrder as jest.Mock
const mockGetProvider = getProvider as jest.Mock

const baseInput = {
  userId: 'user-1',
  direction: 'ON_RAMP' as const,
  fiatAmount: 100,
  fiatCurrency: 'USD',
  assetSymbol: 'USDC',
}

function baseLock(overrides: Record<string, unknown> = {}) {
  return {
    id: 'lock-1',
    userId: 'user-1',
    provider: 'moonpay',
    direction: 'ON_RAMP',
    fiatAmount: 100,
    fiatCurrency: 'USD',
    assetSymbol: 'USDC',
    cryptoAmount: 98.5,
    rate: 0.985,
    fees: { providerFee: 1.5, networkFee: 0, fxSpread: 0 },
    providerQuoteId: 'mp_q_1',
    expiresAt: new Date(Date.now() + 60_000),
    consumedAt: null,
    ...overrides,
  }
}

function fakeMoonpay(overrides: Record<string, unknown> = {}) {
  return {
    name: 'moonpay',
    createOrder: jest.fn().mockResolvedValue({
      providerOrderId: 'mp_order_1',
      checkoutUrl: 'https://pay',
      status: 'PENDING',
      ...overrides,
    }),
    getQuote: jest.fn(),
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockDb.fiatQuoteLock = {
    findUnique: jest.fn(),
    update: jest.fn().mockResolvedValue({}),
  }
  mockDb.fiatOrder = {
    create: jest.fn().mockImplementation(async ({ data }: any) => ({
      id: 'order-1',
      ...data,
    })),
  }
})

describe('createFiatOrder with quoteId', () => {
  it('consumes the lock and persists the locked quote fields on the order', async () => {
    const lock = baseLock()
    mockDb.fiatQuoteLock.findUnique.mockResolvedValue(lock)
    const provider = fakeMoonpay()
    mockGetProvider.mockReturnValue(provider)

    const order = await createFiatOrder(
      { ...baseInput, quoteId: lock.id },
      { walletAddress: 'GWALLET' }
    )

    expect(mockSelectProvider).not.toHaveBeenCalled()
    expect(mockGetProvider).toHaveBeenCalledWith('moonpay')
    expect(mockDb.fiatOrder.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          provider: 'moonpay',
          quoteRate: 0.985,
          quotedCryptoAmount: 98.5,
          providerQuoteId: 'mp_q_1',
          fees: lock.fees,
        }),
      })
    )
    expect(mockDb.fiatQuoteLock.update).toHaveBeenCalledWith({
      where: { id: lock.id },
      data: { consumedAt: expect.any(Date) },
    })
    expect(order.id).toBe('order-1')
  })

  it('rejects an expired lock with quote_expired and does not create an order', async () => {
    mockDb.fiatQuoteLock.findUnique.mockResolvedValue(
      baseLock({ expiresAt: new Date(Date.now() - 1000) })
    )

    await expect(
      createFiatOrder(
        { ...baseInput, quoteId: 'lock-1' },
        { walletAddress: 'GWALLET' }
      )
    ).rejects.toMatchObject({ code: 'quote_expired', status: 409 })

    expect(mockDb.fiatOrder.create).not.toHaveBeenCalled()
  })

  it('rejects an already-consumed lock with quote_already_used', async () => {
    mockDb.fiatQuoteLock.findUnique.mockResolvedValue(
      baseLock({ consumedAt: new Date() })
    )

    await expect(
      createFiatOrder(
        { ...baseInput, quoteId: 'lock-1' },
        { walletAddress: 'GWALLET' }
      )
    ).rejects.toMatchObject({ code: 'quote_already_used', status: 409 })

    expect(mockDb.fiatOrder.create).not.toHaveBeenCalled()
  })

  it('rejects a quote owned by another user with quote_not_found (no existence leak)', async () => {
    mockDb.fiatQuoteLock.findUnique.mockResolvedValue(
      baseLock({ userId: 'someone-else' })
    )

    await expect(
      createFiatOrder(
        { ...baseInput, quoteId: 'lock-1' },
        { walletAddress: 'GWALLET' }
      )
    ).rejects.toMatchObject({ code: 'quote_not_found', status: 404 })
  })

  it('rejects when order parameters do not match the locked quote', async () => {
    mockDb.fiatQuoteLock.findUnique.mockResolvedValue(
      baseLock({ assetSymbol: 'XLM' })
    )

    await expect(
      createFiatOrder(
        { ...baseInput, quoteId: 'lock-1' },
        { walletAddress: 'GWALLET' }
      )
    ).rejects.toMatchObject({ code: 'quote_mismatch', status: 409 })
  })

  it('propagates FiatOrderError instances correctly typed', async () => {
    mockDb.fiatQuoteLock.findUnique.mockResolvedValue(null)
    try {
      await createFiatOrder(
        { ...baseInput, quoteId: 'nope' },
        { walletAddress: 'GWALLET' }
      )
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(FiatOrderError)
    }
  })
})

describe('createFiatOrder without quoteId', () => {
  it('honors an explicit provider preference via PREFER_PROVIDER', async () => {
    const provider = fakeMoonpay()
    provider.getQuote.mockResolvedValue({
      provider: 'moonpay',
      direction: 'ON_RAMP',
      fiatAmount: 100,
      fiatCurrency: 'USD',
      assetSymbol: 'USDC',
      cryptoAmount: 97,
      rate: 0.97,
      fees: null,
      unpriced: true,
    })
    mockSelectProvider.mockReturnValue(provider)

    await createFiatOrder(
      { ...baseInput, provider: 'moonpay' },
      { walletAddress: 'GWALLET' }
    )

    expect(mockSelectProvider).toHaveBeenCalledWith({
      policy: 'PREFER_PROVIDER',
      preferredProvider: 'moonpay',
    })
    expect(mockDb.fiatQuoteLock.update).not.toHaveBeenCalled()
    expect(mockDb.fiatOrder.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ quotedCryptoAmount: 97, fees: null }),
      })
    )
  })

  it('falls back to the registry default policy when neither quoteId nor provider is given', async () => {
    const provider = fakeMoonpay()
    provider.getQuote.mockResolvedValue({
      provider: 'moonpay',
      direction: 'ON_RAMP',
      fiatAmount: 100,
      fiatCurrency: 'USD',
      assetSymbol: 'USDC',
      cryptoAmount: 97,
      fees: null,
      unpriced: true,
    })
    mockSelectProvider.mockReturnValue(provider)

    await createFiatOrder(baseInput, { walletAddress: 'GWALLET' })

    expect(mockSelectProvider).toHaveBeenCalledWith({
      policy: 'DEFAULT',
      preferredProvider: undefined,
    })
  })

  it('records provider failure and rethrows when the just-in-time quote fails', async () => {
    const provider = fakeMoonpay()
    provider.getQuote.mockRejectedValue(new Error('provider down'))
    mockSelectProvider.mockReturnValue(provider)

    await expect(
      createFiatOrder(baseInput, { walletAddress: 'GWALLET' })
    ).rejects.toThrow('provider down')

    expect(recordProviderFailure).toHaveBeenCalledWith('moonpay')
    expect(mockDb.fiatOrder.create).not.toHaveBeenCalled()
  })
})
