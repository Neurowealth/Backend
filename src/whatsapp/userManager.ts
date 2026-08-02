import crypto from 'crypto'
import db from '../db'
import { createCustodialWallet, getWalletByUserId } from '../stellar/wallet'
import {
  getGoalForUser,
  computeGoalProgress,
  GoalProgress,
} from '../goals/service'

export type WhatsAppUser = {
  id: string
  phone: string
  verified: boolean
  walletAddress: string
  balance: number
  otp?: {
    code: string
    expiresAt: number
  }
}

export type PortfolioYieldSummary = {
  totalBalance: number
  totalEarnings: number
  periodEarnings: number
  averageApy: number
}

// In-memory user store (replace with DB in production)
const userStore = new Map<string, WhatsAppUser>()

const OTP_TTL_MS = 1000 * 60 * 5 // 5 minutes

/**
 * Normalize WhatsApp phone identifiers (e.g. whatsapp:+1234567890) into a stable key.
 */
export function normalizePhone(phone: string): string {
  return phone.replace(/^whatsapp:/i, '').trim()
}

export function getUserByPhone(phone: string): WhatsAppUser | null {
  const normalized = normalizePhone(phone)
  return userStore.get(normalized) ?? null
}

export async function createOrGetUser(phone: string): Promise<WhatsAppUser> {
  const normalized = normalizePhone(phone)
  const existing = userStore.get(normalized)
  if (existing) {
    return existing
  }

  const userId = crypto.randomUUID()
  const wallet = await createCustodialWallet(userId)

  const newUser: WhatsAppUser = {
    id: userId,
    phone: normalized,
    verified: false,
    walletAddress: wallet.publicKey,
    balance: 0,
  }

  userStore.set(normalized, newUser)
  return newUser
}

export function generateOtp(phone: string): string {
  const user = getUserByPhone(phone)
  if (!user) {
    throw new Error('User not found')
  }

  const code = Math.floor(100000 + Math.random() * 900000).toString()
  user.otp = {
    code,
    expiresAt: Date.now() + OTP_TTL_MS,
  }

  // Update store for reference
  userStore.set(user.phone, user)

  return code
}

export function verifyOtp(phone: string, code: string): boolean {
  const user = getUserByPhone(phone)
  if (!user || !user.otp) {
    return false
  }

  const now = Date.now()
  if (now > user.otp.expiresAt) {
    delete user.otp
    userStore.set(user.phone, user)
    return false
  }

  if (user.otp.code !== code) {
    return false
  }

  user.verified = true
  delete user.otp
  userStore.set(user.phone, user)
  return true
}

export function getUserWalletAddress(phone: string): string | null {
  const user = getUserByPhone(phone)
  if (!user) return null
  return user.walletAddress
}

export function getBalance(phone: string): number | null {
  const user = getUserByPhone(phone)
  return user ? user.balance : null
}

export async function getPortfolioYieldSummary(
  phone: string
): Promise<PortfolioYieldSummary | null> {
  const user = getUserByPhone(phone)
  if (!user) {
    return null
  }

  const dbUser = await db.user.findUnique({
    where: { walletAddress: user.walletAddress },
    select: { id: true },
  })

  if (!dbUser) {
    return {
      totalBalance: user.balance,
      totalEarnings: 0,
      periodEarnings: 0,
      averageApy: 0,
    }
  }

  const positions = await db.position.findMany({
    where: { userId: dbUser.id, status: 'ACTIVE' },
    select: {
      id: true,
      currentValue: true,
      yieldEarned: true,
      protocolName: true,
      assetSymbol: true,
    },
  })

  if (positions.length === 0) {
    return {
      totalBalance: user.balance,
      totalEarnings: 0,
      periodEarnings: 0,
      averageApy: 0,
    }
  }

  const fromDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  const positionIds = positions.map((position) => position.id)

  const [snapshots, protocolRates] = await Promise.all([
    db.yieldSnapshot.findMany({
      where: {
        positionId: { in: positionIds },
        snapshotAt: { gte: fromDate },
      },
      select: {
        yieldAmount: true,
        apy: true,
      },
    }),
    db.protocolRate.findMany({
      where: {
        OR: positions.map((position) => ({
          protocolName: position.protocolName,
          assetSymbol: position.assetSymbol,
        })),
      },
      orderBy: { fetchedAt: 'desc' },
      select: {
        protocolName: true,
        assetSymbol: true,
        supplyApy: true,
      },
    }),
  ])

  const totalBalance = positions.reduce(
    (sum, position) => sum + Number(position.currentValue),
    0
  )
  const totalEarnings = positions.reduce(
    (sum, position) => sum + Number(position.yieldEarned),
    0
  )
  const periodEarnings = snapshots.reduce(
    (sum, snapshot) => sum + Number(snapshot.yieldAmount),
    0
  )

  let averageApy = 0
  if (snapshots.length > 0) {
    averageApy =
      snapshots.reduce((sum, snapshot) => sum + Number(snapshot.apy), 0) /
      snapshots.length
  } else {
    const latestRatesByPair = new Map<string, number>()
    for (const rate of protocolRates) {
      const key = `${rate.protocolName}:${rate.assetSymbol}`
      if (!latestRatesByPair.has(key)) {
        latestRatesByPair.set(key, Number(rate.supplyApy))
      }
    }

    if (latestRatesByPair.size > 0) {
      const apyValues = Array.from(latestRatesByPair.values())
      averageApy =
        apyValues.reduce((sum, apy) => sum + apy, 0) / apyValues.length
    }
  }

  return {
    totalBalance,
    totalEarnings,
    periodEarnings,
    averageApy,
  }
}

/**
 * Savings goal progress (#281) for a WhatsApp user, resolved from their
 * custodial wallet address the same way getPortfolioYieldSummary is.
 * Returns null when the user has no DB record yet or no goal at all.
 */
export async function getGoalStatus(
  phone: string
): Promise<GoalProgress | null> {
  const user = getUserByPhone(phone)
  if (!user) {
    return null
  }

  const dbUser = await db.user.findUnique({
    where: { walletAddress: user.walletAddress },
    select: { id: true },
  })
  if (!dbUser) {
    return null
  }

  const goal = await getGoalForUser(dbUser.id)
  if (!goal) {
    return null
  }

  return computeGoalProgress(goal.id)
}

export function incrementBalance(phone: string, amount: number): number {
  const user = getUserByPhone(phone)
  if (!user) {
    throw new Error('User not found')
  }
  user.balance = Math.max(0, user.balance + amount)
  userStore.set(user.phone, user)
  return user.balance
}

export function decrementBalance(phone: string, amount: number): number {
  const user = getUserByPhone(phone)
  if (!user) {
    throw new Error('User not found')
  }
  user.balance = Math.max(0, user.balance - amount)
  userStore.set(user.phone, user)
  return user.balance
}

export function getUserForTests(phone: string): WhatsAppUser | null {
  return getUserByPhone(phone)
}

export function clearUsersForTests(): void {
  userStore.clear()
}

export async function ensureWalletDecrypted(phone: string) {
  const user = getUserByPhone(phone)
  if (!user) throw new Error('User not found')

  // Read from wallet store to ensure decryption works.
  // This is used in tests to ensure secret keys are not stored in plaintext.
  await getWalletByUserId(user.id)
}
