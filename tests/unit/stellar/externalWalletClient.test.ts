import { fetchWithRetry } from '../../../src/utils/fetchWithRetry'
import { getExternalWalletBalances } from '../../../src/stellar/client'

jest.mock('../../../src/utils/fetchWithRetry', () => ({
  fetchWithRetry: jest.fn(),
}))

const mockFetchWithRetry = fetchWithRetry as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  delete process.env.HORIZON_URL
  process.env.STELLAR_NETWORK = 'testnet'
})

describe('getExternalWalletBalances', () => {
  it('uses the network Horizon endpoint and bounded read options', async () => {
    mockFetchWithRetry.mockResolvedValue({
      balances: [
        { asset_type: 'native', balance: '5.25' },
        {
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          asset_issuer: 'G'.repeat(56),
          balance: '10.125',
        },
      ],
    })

    await expect(
      getExternalWalletBalances('G'.repeat(56))
    ).resolves.toMatchObject([
      { assetCode: 'XLM', amount: '5.25' },
      { assetCode: 'USDC', amount: '10.125' },
    ])
    expect(mockFetchWithRetry).toHaveBeenCalledWith(
      `https://horizon-testnet.stellar.org/accounts/${'G'.repeat(56)}`,
      {
        timeout: 5_000,
        retries: 2,
        maxResponseBytes: 128 * 1024,
      }
    )
  })

  it('uses HORIZON_URL when explicitly configured', async () => {
    process.env.HORIZON_URL = 'https://horizon.example///'
    mockFetchWithRetry.mockResolvedValue({ balances: [] })

    await getExternalWalletBalances('G'.repeat(56))

    expect(mockFetchWithRetry).toHaveBeenCalledWith(
      `https://horizon.example/accounts/${'G'.repeat(56)}`,
      expect.any(Object)
    )
  })

  it('rejects malformed or over-limit balance snapshots', async () => {
    mockFetchWithRetry.mockResolvedValue({ balances: [] })
    await expect(getExternalWalletBalances('G'.repeat(56))).resolves.toEqual([])

    mockFetchWithRetry.mockResolvedValue({})
    await expect(getExternalWalletBalances('G'.repeat(56))).rejects.toThrow(
      'omitted balances'
    )

    mockFetchWithRetry.mockResolvedValue({
      balances: Array.from({ length: 101 }, (_, index) => ({
        asset_type: 'credit_alphanum4',
        asset_code: `A${index}`,
        asset_issuer: 'G'.repeat(56),
        balance: '1',
      })),
    })
    await expect(getExternalWalletBalances('G'.repeat(56))).rejects.toThrow(
      'trustline sync limit'
    )
  })
})
