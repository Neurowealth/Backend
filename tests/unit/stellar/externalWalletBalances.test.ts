import {
  MAX_EXTERNAL_WALLET_TRUSTLINES,
  normalizeExternalWalletBalances,
} from '../../../src/stellar/externalWalletBalances'

describe('normalizeExternalWalletBalances', () => {
  it('normalizes native and issued balances without losing decimal precision', () => {
    expect(
      normalizeExternalWalletBalances([
        { asset_type: 'native', balance: '1.1234567' },
        {
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          asset_issuer: 'G'.repeat(56),
          balance: '5.0000001',
        },
      ])
    ).toEqual([
      {
        assetType: 'native',
        assetCode: 'XLM',
        assetIssuer: null,
        amount: '1.1234567',
      },
      {
        assetType: 'credit_alphanum4',
        assetCode: 'USDC',
        assetIssuer: 'G'.repeat(56),
        amount: '5.0000001',
      },
    ])
  })

  it('rejects an over-limit snapshot instead of returning partial balances', () => {
    const balances = Array.from(
      { length: MAX_EXTERNAL_WALLET_TRUSTLINES + 1 },
      (_, index) => ({
        asset_type: 'credit_alphanum4',
        asset_code: `A${index}`,
        asset_issuer: 'G'.repeat(56),
        balance: '1',
      })
    )

    expect(() => normalizeExternalWalletBalances(balances)).toThrow(
      'trustline sync limit'
    )
  })
})
