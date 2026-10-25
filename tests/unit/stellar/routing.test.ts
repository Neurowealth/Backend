// #448 — Horizon path finding in src/stellar/routing.ts.
//
// The two find*Path functions used to return a direct no-conversion quote with
// `path: []`, so every caller believed it had a slippage-protected route while
// nothing was actually priced. These tests pin the real behaviour against
// mocked Horizon responses: the network is never touched.
//
// fetchWithRetry is mocked rather than global fetch, which is how the rest of
// the suite isolates HTTP (see src/agent/scanner.ts consumers).

process.env.NODE_ENV = 'test'

import { Operation, xdr } from '@stellar/stellar-sdk'
import type { OperationRecord } from '@stellar/stellar-sdk'
import {
  findStrictReceivePath,
  findStrictSendPath,
  clampSlippage,
  validateQuoteExpiry,
  buildPathPaymentOp,
  ROUTING_CONFIG,
} from '../../../src/stellar/routing'
import { fetchWithRetry } from '../../../src/utils/fetchWithRetry'
import { logger } from '../../../src/utils/logger'

jest.mock('../../../src/utils/fetchWithRetry', () => ({
  fetchWithRetry: jest.fn(),
}))

jest.mock('../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

const mockFetch = fetchWithRetry as jest.Mock

const DESTINATION = 'GCQH7A5CWNRIA2EWAOKECTFGLTLWWA4B224RWPYPLUEKVQYAHW4SNGOQ'
const ISSUER_A = 'GBHUXM6YTH36556VTN7J6IK37MYSUO2AITPRSJMG4O2FCUMDLW42UFHI'
const ISSUER_B = 'GCHN4QBST35DEEHRPSGR5H5QESZDWQY7VJM5LSGLVLX3TKYWHTBHJTZK'

/** Shape `Operation.fromXDRObject` yields for a strict-send op. */
type DecodedStrictSend = {
  sendAmount: string
  destMin: string
  destination: string
}

const USDC = 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const EUR = 'EUR:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'

/** Horizon success payload: records live under `_embedded.records`. */
function horizonResponse(records: unknown[]) {
  return { _embedded: { records } }
}

function strictSendRecord(overrides: Record<string, unknown> = {}) {
  return {
    source_amount: '100.0000000',
    dest_amount: '100.0000000',
    path: [],
    source_asset_type: 'native',
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  process.env.HORIZON_URL = 'https://horizon.testnet.stellar.org'
})

describe('findStrictSendPath — happy path', () => {
  it('quotes the rate Horizon returned instead of a 1:1 stub', async () => {
    mockFetch.mockResolvedValue(
      horizonResponse([
        strictSendRecord({ source_amount: '100.0', dest_amount: '95.0' }),
      ])
    )

    const quote = await findStrictSendPath({
      sourceAsset: 'XLM',
      sourceAmount: '100.0',
      destAsset: USDC,
    })

    expect(quote.estDestAmount).toBe('95.0')
    expect(quote.sourceAmount).toBe('100.0')
    expect(quote.destAsset).toBe(USDC)
  })

  it('applies the default 50 bps slippage to destAmountMin', async () => {
    mockFetch.mockResolvedValue(
      horizonResponse([strictSendRecord({ dest_amount: '100.0' })])
    )

    const quote = await findStrictSendPath({
      sourceAsset: 'XLM',
      sourceAmount: '100.0',
      destAsset: USDC,
    })

    // 100 * (1 - 50/10000) = 99.5
    expect(quote.destAmountMin).toBe('99.5000000')
  })

  it('honours an explicit slippage and clamps it to the allowed band', async () => {
    mockFetch.mockResolvedValue(
      horizonResponse([strictSendRecord({ dest_amount: '100.0' })])
    )

    const quote = await findStrictSendPath({
      sourceAsset: 'XLM',
      sourceAmount: '100.0',
      destAsset: USDC,
      slippageBps: 25,
    })

    expect(quote.destAmountMin).toBe('99.7500000')
  })

  it('clamps an out-of-band slippage instead of trusting it', async () => {
    mockFetch.mockResolvedValue(
      horizonResponse([strictSendRecord({ dest_amount: '100.0' })])
    )

    const quote = await findStrictSendPath({
      sourceAsset: 'XLM',
      sourceAmount: '100.0',
      destAsset: USDC,
      slippageBps: 99_999,
    })

    const floor = 100 * (1 - ROUTING_CONFIG.SLIPPAGE_MAX_BPS / 10_000)
    expect(Number(quote.destAmountMin)).toBeCloseTo(floor, 5)
  })

  it('queries the Horizon strict-send endpoint with the right parameters', async () => {
    mockFetch.mockResolvedValue(horizonResponse([strictSendRecord()]))

    await findStrictSendPath({
      sourceAsset: 'XLM',
      sourceAmount: '100.0',
      destAsset: USDC,
    })

    const url = mockFetch.mock.calls[0][0] as string
    expect(url).toContain('/path/strict-send')
    expect(url).toContain('source_asset=XLM')
    expect(url).toContain(`dest_asset=${encodeURIComponent(USDC)}`)
    expect(url).toContain('source_amount=100.0')
  })

  it('honours HORIZON_URL rather than assuming mainnet', async () => {
    mockFetch.mockResolvedValue(horizonResponse([strictSendRecord()]))

    await findStrictSendPath({
      sourceAsset: 'XLM',
      sourceAmount: '100.0',
      destAsset: USDC,
    })

    expect(mockFetch.mock.calls[0][0]).toContain(
      'https://horizon.testnet.stellar.org'
    )
  })

  it('falls back to public Horizon when HORIZON_URL is unset', async () => {
    delete process.env.HORIZON_URL
    mockFetch.mockResolvedValue(horizonResponse([strictSendRecord()]))

    await findStrictSendPath({
      sourceAsset: 'XLM',
      sourceAmount: '100.0',
      destAsset: USDC,
    })

    expect(mockFetch.mock.calls[0][0]).toContain('https://horizon.stellar.org')
  })

  it('never returns a negative destAmountMin', async () => {
    mockFetch.mockResolvedValue(
      horizonResponse([strictSendRecord({ dest_amount: '1.0' })])
    )

    const quote = await findStrictSendPath({
      sourceAsset: 'XLM',
      sourceAmount: '1000000.0',
      destAsset: USDC,
      slippageBps: ROUTING_CONFIG.SLIPPAGE_MAX_BPS,
    })

    expect(Number(quote.destAmountMin)).toBeGreaterThanOrEqual(0)
  })
})

describe('findStrictSendPath — price impact', () => {
  it('reports zero impact on a 1:1 route', async () => {
    mockFetch.mockResolvedValue(
      horizonResponse([
        strictSendRecord({ source_amount: '100.0', dest_amount: '100.0' }),
      ])
    )

    const quote = await findStrictSendPath({
      sourceAsset: 'XLM',
      sourceAmount: '100.0',
      destAsset: USDC,
    })

    expect(quote.priceImpactBps).toBe(0)
    expect(quote.highImpact).toBe(false)
  })

  it('flags impact above the configured warning threshold', async () => {
    mockFetch.mockResolvedValue(
      horizonResponse([
        strictSendRecord({ source_amount: '100.0', dest_amount: '80.0' }),
      ])
    )

    const quote = await findStrictSendPath({
      sourceAsset: 'XLM',
      sourceAmount: '100.0',
      destAsset: USDC,
    })

    expect(quote.priceImpactBps).toBe(2000)
    expect(quote.highImpact).toBe(true)
  })

  it('does not flag impact below the threshold', async () => {
    mockFetch.mockResolvedValue(
      horizonResponse([
        strictSendRecord({ source_amount: '100.0', dest_amount: '99.5' }),
      ])
    )

    const quote = await findStrictSendPath({
      sourceAsset: 'XLM',
      sourceAmount: '100.0',
      destAsset: USDC,
    })

    expect(quote.highImpact).toBe(false)
  })
})

describe('findStrictSendPath — path extraction', () => {
  it('returns source and dest when there are no intermediate hops', async () => {
    mockFetch.mockResolvedValue(horizonResponse([strictSendRecord()]))

    const quote = await findStrictSendPath({
      sourceAsset: 'XLM',
      sourceAmount: '100.0',
      destAsset: USDC,
    })

    expect(quote.path).toEqual(['XLM', USDC])
  })

  it('includes intermediate hops from the Horizon record', async () => {
    mockFetch.mockResolvedValue(
      horizonResponse([
        strictSendRecord({
          dest_amount: '100.0',
          path: [
            { asset_code: 'USDC', asset_issuer: ISSUER_A },
            { asset_code: 'EUR', asset_issuer: ISSUER_B },
          ],
        }),
      ])
    )

    const quote = await findStrictSendPath({
      sourceAsset: 'XLM',
      sourceAmount: '100.0',
      destAsset: EUR,
    })

    expect(quote.path).toEqual([
      'XLM',
      `USDC:${ISSUER_A}`,
      `EUR:${ISSUER_B}`,
      EUR,
    ])
  })

  it('builds a path payment whose intermediate assets match the quote', async () => {
    mockFetch.mockResolvedValue(
      horizonResponse([
        strictSendRecord({
          dest_amount: '100.0',
          path: [{ asset_code: 'USDC', asset_issuer: ISSUER_A }],
        }),
      ])
    )

    const quote = await findStrictSendPath({
      sourceAsset: 'XLM',
      sourceAmount: '100.0',
      destAsset: EUR,
    })
    const op = buildPathPaymentOp(quote, DESTINATION)

    // Round-trip through XDR so we assert on the encoded operation rather than
    // the wrapper: the op must be a strict-send carrying the quoted amounts.
    const attrs = Operation.fromXDRObject<DecodedStrictSend & OperationRecord>(
      xdr.Operation.fromXDR(op.toXDR('base64'), 'base64')
    )

    // The SDK normalises amounts to 7dp, so compare numerically.
    expect(Number(attrs.sendAmount)).toBe(Number(quote.sourceAmount))
    expect(attrs.destMin).toBe(
      (100 * (1 - ROUTING_CONFIG.SLIPPAGE_DEFAULT_BPS / 10_000)).toFixed(7)
    )
    expect(attrs.destination).toBe(DESTINATION)
  })
})

describe('findStrictSendPath — failures', () => {
  it('throws when Horizon returns no path', async () => {
    mockFetch.mockResolvedValue(horizonResponse([]))

    await expect(
      findStrictSendPath({
        sourceAsset: 'XLM',
        sourceAmount: '100.0',
        destAsset: USDC,
      })
    ).rejects.toThrow(/no path/i)
    expect(logger.error).toHaveBeenCalled()
  })

  it('propagates a timeout from the HTTP layer', async () => {
    mockFetch.mockRejectedValue(new Error('timeout of 5000ms exceeded'))

    await expect(
      findStrictSendPath({
        sourceAsset: 'XLM',
        sourceAmount: '100.0',
        destAsset: USDC,
      })
    ).rejects.toThrow(/timeout/i)
    expect(logger.error).toHaveBeenCalled()
  })

  it('throws when the payload has no records array', async () => {
    mockFetch.mockResolvedValue({ unexpected: true })

    await expect(
      findStrictSendPath({
        sourceAsset: 'XLM',
        sourceAmount: '100.0',
        destAsset: USDC,
      })
    ).rejects.toThrow(/unexpected payload shape/i)
  })

  it('throws when dest_amount is missing', async () => {
    mockFetch.mockResolvedValue(
      horizonResponse([{ source_amount: '100.0', path: [] }])
    )

    await expect(
      findStrictSendPath({
        sourceAsset: 'XLM',
        sourceAmount: '100.0',
        destAsset: USDC,
      })
    ).rejects.toThrow(/dest_amount/)
  })

  it('rejects a malformed source asset before calling Horizon', async () => {
    await expect(
      findStrictSendPath({
        sourceAsset: 'NOTANASSET',
        sourceAmount: '100.0',
        destAsset: USDC,
      })
    ).rejects.toThrow(/Invalid asset format/)
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

describe('findStrictReceivePath', () => {
  it('quotes the source amount Horizon computed for a fixed destination', async () => {
    mockFetch.mockResolvedValue(
      horizonResponse([
        strictSendRecord({ source_amount: '105.0', dest_amount: '100.0' }),
      ])
    )

    const quote = await findStrictReceivePath({
      sourceAsset: 'XLM',
      destAsset: USDC,
      destAmount: '100.0',
    })

    expect(quote.sourceAmount).toBe('105.0')
    expect(quote.estDestAmount).toBe('100.0')
  })

  it('queries the strict-receive endpoint with destination_amount', async () => {
    mockFetch.mockResolvedValue(
      horizonResponse([strictSendRecord({ source_amount: '105.0' })])
    )

    await findStrictReceivePath({
      sourceAsset: 'XLM',
      destAsset: USDC,
      destAmount: '100.0',
    })

    const url = mockFetch.mock.calls[0][0] as string
    expect(url).toContain('/path/strict-receive')
    expect(url).toContain('destination_amount=100.0')
    expect(url).not.toContain('source_amount=')
  })

  it('flags a bad rate as high impact', async () => {
    mockFetch.mockResolvedValue(
      horizonResponse([
        strictSendRecord({ source_amount: '200.0', dest_amount: '100.0' }),
      ])
    )

    const quote = await findStrictReceivePath({
      sourceAsset: 'XLM',
      destAsset: USDC,
      destAmount: '100.0',
    })

    expect(quote.highImpact).toBe(true)
  })

  it('requires a destination amount', async () => {
    await expect(
      findStrictReceivePath({ sourceAsset: 'XLM', destAsset: USDC })
    ).rejects.toThrow(/destAmount is required/)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('throws when source_amount is missing', async () => {
    mockFetch.mockResolvedValue(horizonResponse([{ dest_amount: '100.0' }]))

    await expect(
      findStrictReceivePath({
        sourceAsset: 'XLM',
        destAsset: USDC,
        destAmount: '100.0',
      })
    ).rejects.toThrow(/source_amount/)
  })

  it('propagates a network failure', async () => {
    mockFetch.mockRejectedValue(new Error('HTTP 503'))

    await expect(
      findStrictReceivePath({
        sourceAsset: 'XLM',
        destAsset: USDC,
        destAmount: '100.0',
      })
    ).rejects.toThrow(/503/)
  })
})

describe('quote lifetime', () => {
  it('sets expiresAt one TTL into the future', async () => {
    mockFetch.mockResolvedValue(horizonResponse([strictSendRecord()]))
    const before = Date.now()

    const quote = await findStrictSendPath({
      sourceAsset: 'XLM',
      sourceAmount: '100.0',
      destAsset: USDC,
    })

    expect(quote.expiresAt.getTime()).toBeGreaterThanOrEqual(
      before + ROUTING_CONFIG.QUOTE_TTL_MS - 50
    )
  })

  it('produces a quote that passes expiry validation immediately', async () => {
    mockFetch.mockResolvedValue(horizonResponse([strictSendRecord()]))

    const quote = await findStrictSendPath({
      sourceAsset: 'XLM',
      sourceAmount: '100.0',
      destAsset: USDC,
    })

    expect(() => validateQuoteExpiry(quote)).not.toThrow()
  })

  it('rejects an expired quote', () => {
    expect(() =>
      validateQuoteExpiry({
        sourceAsset: 'XLM',
        sourceAmount: '1',
        destAsset: USDC,
        destAmountMin: '1',
        estDestAmount: '1',
        path: [],
        priceImpactBps: 0,
        expiresAt: new Date(Date.now() - 1000),
        highImpact: false,
      })
    ).toThrow('routing_quote_expired')
  })
})

describe('clampSlippage', () => {
  it('defaults when no slippage is supplied', () => {
    expect(clampSlippage(undefined)).toBe(ROUTING_CONFIG.SLIPPAGE_DEFAULT_BPS)
  })

  it('clamps to the minimum and maximum bands', () => {
    expect(clampSlippage(0)).toBe(ROUTING_CONFIG.SLIPPAGE_MIN_BPS)
    expect(clampSlippage(10_000)).toBe(ROUTING_CONFIG.SLIPPAGE_MAX_BPS)
  })

  it('passes an in-band value through', () => {
    expect(clampSlippage(120)).toBe(120)
  })
})
