// #313 — Best-execution quote flow: parallel multi-provider fan-out, ranking,
// per-quote locking, and graceful partial failure.
import db from '../../../src/db'
import {
  getHealthyProviders,
  getAllProviderHealth,
  recordProviderSuccess,
  recordProviderFailure,
} from '../../../src/fiat/registry'
import { getBestExecutionQuote } from '../../../src/fiat/service'
import { NoHealthyProvidersError } from '../../../src/fiat/types'
import type { QuoteResult } from '../../../src/fiat/types'

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
  getHealthyProviders: jest.fn(),
  getAllProviderHealth: jest.fn().mockReturnValue([]),
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
const mockGetHealthyProviders = getHealthyProviders as jest.Mock
const mockGetAllProviderHealth = getAllProviderHealth as jest.Mock

function makeQuote(provider: string, cryptoAmount: number): QuoteResult {
  return {
    provider,
    direction: 'ON_RAMP',
    fiatAmount: 100,
    fiatCurrency: 'USD',
    assetSymbol: 'USDC',
    cryptoAmount,
    fees: { providerFee: 1, networkFee: 0.1, fxSpread: 0 },
    unpriced: false,
  }
}

function fakeProvider(
  name: string,
  impl: () => Promise<QuoteResult>
): { name: string; getQuote: () => Promise<QuoteResult> } {
  return { name, getQuote: impl }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockDb.fiatQuoteLock = {
    create: jest.fn().mockImplementation(async ({ data }: any) => ({
      id: `lock-${data.provider}`,
      ...data,
    })),
  }
})

afterEach(() => {
  jest.useRealTimers()
})

describe('getBestExecutionQuote', () => {
  it('ranks ON_RAMP quotes with the highest crypto amount first', async () => {
    mockGetHealthyProviders.mockReturnValue([
      fakeProvider('alpha', async () => makeQuote('alpha', 100)),
      fakeProvider('beta', async () => makeQuote('beta', 105)),
    ])

    const result = await getBestExecutionQuote(
      {
        direction: 'ON_RAMP',
        fiatAmount: 100,
        fiatCurrency: 'USD',
        assetSymbol: 'USDC',
      },
      { userId: 'user-1' }
    )

    expect(result.best?.provider).toBe('beta')
    expect(result.quotes.map((q) => q.provider)).toEqual(['beta', 'alpha'])
    expect(result.quotes[0].rank).toBe(1)
    expect(result.quotes[1].rank).toBe(2)
    expect(result.quotes.every((q) => typeof q.quoteId === 'string')).toBe(true)
    expect(result.excluded).toEqual([])
    expect(recordProviderSuccess).toHaveBeenCalledWith('alpha')
    expect(recordProviderSuccess).toHaveBeenCalledWith('beta')
  })

  it('ranks OFF_RAMP quotes with the lowest crypto amount first (least crypto given up is best)', async () => {
    mockGetHealthyProviders.mockReturnValue([
      fakeProvider('alpha', async () => ({
        ...makeQuote('alpha', 102),
        direction: 'OFF_RAMP',
      })),
      fakeProvider('beta', async () => ({
        ...makeQuote('beta', 98),
        direction: 'OFF_RAMP',
      })),
    ])

    const result = await getBestExecutionQuote(
      {
        direction: 'OFF_RAMP',
        fiatAmount: 100,
        fiatCurrency: 'USD',
        assetSymbol: 'USDC',
      },
      { userId: 'user-1' }
    )

    expect(result.best?.provider).toBe('beta')
    expect(result.quotes.map((q) => q.provider)).toEqual(['beta', 'alpha'])
  })

  it('excludes a provider that errors, with a reason, and still ranks the healthy ones', async () => {
    mockGetHealthyProviders.mockReturnValue([
      fakeProvider('broken', async () => {
        throw new Error('vendor 500')
      }),
      fakeProvider('good', async () => makeQuote('good', 100)),
    ])

    const result = await getBestExecutionQuote(
      {
        direction: 'ON_RAMP',
        fiatAmount: 100,
        fiatCurrency: 'USD',
        assetSymbol: 'USDC',
      },
      { userId: 'user-1' }
    )

    expect(result.best?.provider).toBe('good')
    expect(result.quotes).toHaveLength(1)
    expect(result.excluded).toEqual([
      expect.objectContaining({
        provider: 'broken',
        reason: expect.stringContaining('vendor 500'),
      }),
    ])
    expect(recordProviderFailure).toHaveBeenCalledWith('broken')
  })

  it('excludes a provider that times out without blocking the others', async () => {
    jest.useFakeTimers()
    mockGetHealthyProviders.mockReturnValue([
      fakeProvider('slow', () => new Promise(() => {})),
      fakeProvider('fast', async () => makeQuote('fast', 100)),
    ])

    const promise = getBestExecutionQuote(
      {
        direction: 'ON_RAMP',
        fiatAmount: 100,
        fiatCurrency: 'USD',
        assetSymbol: 'USDC',
      },
      { userId: 'user-1' }
    )

    await jest.advanceTimersByTimeAsync(10_000)
    const result = await promise

    expect(result.best?.provider).toBe('fast')
    expect(result.excluded).toEqual([
      expect.objectContaining({
        provider: 'slow',
        reason: expect.stringContaining('timed out'),
      }),
    ])
  })

  it('throws NoHealthyProvidersError with per-provider reasons when nothing is healthy', async () => {
    mockGetHealthyProviders.mockReturnValue([])
    mockGetAllProviderHealth.mockReturnValue([
      { provider: 'alpha', state: 'open', consecutiveFailures: 5 },
      { provider: 'beta', state: 'open', consecutiveFailures: 7 },
    ])

    await expect(
      getBestExecutionQuote(
        {
          direction: 'ON_RAMP',
          fiatAmount: 100,
          fiatCurrency: 'USD',
          assetSymbol: 'USDC',
        },
        { userId: 'user-1' }
      )
    ).rejects.toBeInstanceOf(NoHealthyProvidersError)
    expect(mockDb.fiatQuoteLock.create).not.toHaveBeenCalled()
  })

  it('labels a fee-less quote as unpriced rather than assuming zero', async () => {
    mockGetHealthyProviders.mockReturnValue([
      fakeProvider('nobreakdown', async () => ({
        ...makeQuote('nobreakdown', 100),
        fees: null,
        unpriced: true,
      })),
    ])

    const result = await getBestExecutionQuote(
      {
        direction: 'ON_RAMP',
        fiatAmount: 100,
        fiatCurrency: 'USD',
        assetSymbol: 'USDC',
      },
      { userId: 'user-1' }
    )

    expect(result.best?.fees).toBeNull()
    expect(result.best?.unpriced).toBe(true)
  })
})
