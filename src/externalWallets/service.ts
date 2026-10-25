import { StrKey } from '@stellar/stellar-sdk'
import { Prisma } from '@prisma/client'
import db from '../db'
import { getExternalWalletBalances } from '../stellar/client'
import type { ExternalWalletBalance } from '../stellar/externalWalletBalances'

const MAX_LINKED_WALLETS_PER_USER = 5
const SYNC_BATCH_SIZE = 25
export const EXTERNAL_WALLET_STALE_AFTER_MS = 30 * 60 * 1000

export class ExternalWalletConflictError extends Error {}
export class ExternalWalletValidationError extends Error {}

export function isSupportedStellarPublicKey(publicKey: string): boolean {
  return StrKey.isValidEd25519PublicKey(publicKey)
}

export async function linkExternalWallet(
  userId: string,
  input: { publicKey: string; label: string }
) {
  const publicKey = input.publicKey.trim()
  const label = input.label.trim()
  if (!isSupportedStellarPublicKey(publicKey)) {
    throw new ExternalWalletValidationError('Invalid Stellar public key')
  }
  if (!label || label.length > 60) {
    throw new ExternalWalletValidationError('Label must be 1 to 60 characters')
  }

  const [user, custodialWallet, existing, count] = await Promise.all([
    db.user.findUnique({
      where: { id: userId },
      select: { walletAddress: true },
    }),
    db.custodialWallet.findFirst({
      where: { userId, publicKey },
      select: { id: true },
    }),
    db.linkedExternalWallet.findUnique({
      where: { userId_publicKey: { userId, publicKey } },
      select: { id: true },
    }),
    db.linkedExternalWallet.count({ where: { userId } }),
  ])

  if (user?.walletAddress === publicKey || custodialWallet) {
    throw new ExternalWalletConflictError(
      'This address is already a platform-managed wallet'
    )
  }
  if (existing) {
    throw new ExternalWalletConflictError(
      'This external wallet is already linked'
    )
  }
  if (count >= MAX_LINKED_WALLETS_PER_USER) {
    throw new ExternalWalletConflictError(
      `A maximum of ${MAX_LINKED_WALLETS_PER_USER} external wallets may be linked`
    )
  }

  try {
    return await db.linkedExternalWallet.create({
      data: {
        userId,
        publicKey,
        label,
        verificationStatus: 'UNVERIFIED_SELF_REPORTED',
      },
    })
  } catch (error) {
    if ((error as { code?: string })?.code === 'P2002') {
      throw new ExternalWalletConflictError(
        'This external wallet is already linked'
      )
    }
    throw error
  }
}

export function listExternalWallets(userId: string) {
  return db.linkedExternalWallet.findMany({
    where: { userId },
    orderBy: { addedAt: 'desc' },
  })
}

export async function removeExternalWallet(
  userId: string,
  walletId: string
): Promise<boolean> {
  const result = await db.linkedExternalWallet.deleteMany({
    where: { id: walletId, userId },
  })
  return result.count === 1
}

export function valueExternalBalanceUsd(
  balance: ExternalWalletBalance,
  usdcIssuer = process.env.USDC_ISSUER
): number | null {
  if (
    balance.assetCode !== 'USDC' ||
    !usdcIssuer ||
    balance.assetIssuer !== usdcIssuer
  ) {
    return null
  }
  const amount = Number(balance.amount)
  return Number.isFinite(amount) ? amount : null
}

export function sumKnownExternalBalancesUsd(
  value: unknown,
  usdcIssuer = process.env.USDC_ISSUER
): number {
  if (!Array.isArray(value)) return 0
  return value.reduce((sum: number, entry: unknown) => {
    if (!entry || typeof entry !== 'object') return sum
    const balance = entry as ExternalWalletBalance
    if (
      typeof balance.amount !== 'string' ||
      typeof balance.assetCode !== 'string'
    ) {
      return sum
    }
    return sum + (valueExternalBalanceUsd(balance, usdcIssuer) ?? 0)
  }, 0)
}

export async function syncLinkedExternalWallets(
  readBalances: typeof getExternalWalletBalances = getExternalWalletBalances
): Promise<{ attempted: number; synced: number; failed: number }> {
  const wallets = await db.linkedExternalWallet.findMany({
    orderBy: [
      { lastSyncAttemptAt: { sort: 'asc', nulls: 'first' } },
      { addedAt: 'asc' },
    ],
    take: SYNC_BATCH_SIZE,
  })

  let attempted = 0
  let synced = 0
  let failed = 0
  for (const wallet of wallets) {
    const attemptedAt = new Date()
    const claimed = await db.linkedExternalWallet.updateMany({
      where: {
        id: wallet.id,
        lastSyncAttemptAt: wallet.lastSyncAttemptAt ?? null,
      },
      data: { lastSyncAttemptAt: attemptedAt },
    })
    if (claimed.count !== 1) continue
    attempted++

    try {
      const balances = await readBalances(wallet.publicKey)
      await db.linkedExternalWallet.updateMany({
        where: { id: wallet.id },
        data: {
          balances: balances as unknown as Prisma.InputJsonValue,
          lastSyncedAt: new Date(),
          lastSyncAttemptAt: attemptedAt,
          syncError: null,
        },
      })
      synced++
    } catch (error) {
      await db.linkedExternalWallet.updateMany({
        where: { id: wallet.id },
        data: {
          lastSyncAttemptAt: attemptedAt,
          syncError: (error instanceof Error
            ? error.message
            : String(error)
          ).slice(0, 500),
        },
      })
      failed++
    }
  }

  return { attempted, synced, failed }
}
