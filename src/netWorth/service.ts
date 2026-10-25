import db from '../db'
import { valueExternalBalanceUsd } from '../externalWallets/service'
import type { ExternalWalletBalance } from '../stellar/externalWalletBalances'
import { EXTERNAL_WALLET_STALE_AFTER_MS } from '../externalWallets/service'

export { EXTERNAL_WALLET_STALE_AFTER_MS } from '../externalWallets/service'

function readBalances(value: unknown): ExternalWalletBalance[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (balance): balance is ExternalWalletBalance =>
      typeof balance === 'object' &&
      balance !== null &&
      typeof (balance as ExternalWalletBalance).amount === 'string' &&
      typeof (balance as ExternalWalletBalance).assetCode === 'string'
  )
}

export async function getNetWorth(userId: string) {
  const [positions, wallets] = await Promise.all([
    db.position.findMany({
      where: { userId, status: 'ACTIVE' },
      select: {
        id: true,
        protocolName: true,
        assetSymbol: true,
        currentValue: true,
      },
    }),
    db.linkedExternalWallet.findMany({
      where: { userId },
      orderBy: { addedAt: 'desc' },
    }),
  ])

  const platformHoldings = positions.map((position) => ({
    id: position.id,
    assetCode: position.assetSymbol,
    protocol: position.protocolName,
    amount: null,
    valueUsd: Number(position.currentValue),
    source: 'platform' as const,
  }))

  const asOf = new Date()
  const walletViews = wallets.map((wallet) => {
    const balances = readBalances(wallet.balances)
    const stale =
      !wallet.lastSyncedAt ||
      Boolean(wallet.syncError) ||
      Boolean(
        wallet.lastSyncAttemptAt &&
        wallet.lastSyncedAt &&
        wallet.lastSyncAttemptAt > wallet.lastSyncedAt
      ) ||
      asOf.getTime() - wallet.lastSyncedAt.getTime() >
        EXTERNAL_WALLET_STALE_AFTER_MS
    const holdings = balances.map((balance) => ({
      assetCode: balance.assetCode,
      assetIssuer: balance.assetIssuer,
      amount: balance.amount,
      valueUsd: valueExternalBalanceUsd(balance),
      source: 'external' as const,
      walletId: wallet.id,
      label: wallet.label,
      verificationStatus: wallet.verificationStatus,
      asOf: wallet.lastSyncedAt?.toISOString() ?? null,
      stale,
    }))
    return {
      id: wallet.id,
      label: wallet.label,
      publicKey: wallet.publicKey,
      verificationStatus: wallet.verificationStatus,
      verified: false,
      addedAt: wallet.addedAt.toISOString(),
      lastSyncedAt: wallet.lastSyncedAt?.toISOString() ?? null,
      stale,
      syncFailed: Boolean(wallet.syncError),
      holdings,
    }
  })

  const externalHoldings = walletViews.flatMap((wallet) => wallet.holdings)
  const platformValueUsd = platformHoldings.reduce(
    (sum, holding) => sum + holding.valueUsd,
    0
  )
  const externalKnownValueUsd = externalHoldings.reduce(
    (sum, holding) => sum + (holding.valueUsd ?? 0),
    0
  )
  const unpricedExternalHoldingCount = externalHoldings.filter(
    (holding) => holding.valueUsd === null
  ).length

  return {
    currency: 'USD',
    totalKnownUsd: platformValueUsd + externalKnownValueUsd,
    platformValueUsd,
    externalKnownValueUsd,
    valuationComplete:
      unpricedExternalHoldingCount === 0 &&
      walletViews.every((wallet) => !wallet.stale),
    unpricedExternalHoldingCount,
    staleWalletCount: walletViews.filter((wallet) => wallet.stale).length,
    holdings: [...platformHoldings, ...externalHoldings],
    externalWallets: walletViews,
  }
}
