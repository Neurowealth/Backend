export const MAX_EXTERNAL_WALLET_TRUSTLINES = 100

export interface ExternalWalletBalance {
  assetType: string
  assetCode: string
  assetIssuer: string | null
  amount: string
}

interface HorizonBalance {
  asset_type: string
  asset_code?: string
  asset_issuer?: string
  balance: string
}

export function normalizeExternalWalletBalances(
  balances: HorizonBalance[]
): ExternalWalletBalance[] {
  const trustlines = balances.filter(
    (balance) => balance.asset_type !== 'native'
  )
  if (trustlines.length > MAX_EXTERNAL_WALLET_TRUSTLINES) {
    throw new Error(
      `External wallet exceeds the ${MAX_EXTERNAL_WALLET_TRUSTLINES} trustline sync limit`
    )
  }

  return balances
    .filter((balance) => Number(balance.balance) > 0)
    .map((balance) => {
      if (balance.asset_type === 'native') {
        return {
          assetType: 'native',
          assetCode: 'XLM',
          assetIssuer: null,
          amount: balance.balance,
        }
      }

      if (
        !balance.asset_type.startsWith('credit_') ||
        !balance.asset_code ||
        !balance.asset_issuer
      ) {
        throw new Error('Horizon returned an unsupported balance entry')
      }

      return {
        assetType: balance.asset_type,
        assetCode: balance.asset_code,
        assetIssuer: balance.asset_issuer,
        amount: balance.balance,
      }
    })
}
