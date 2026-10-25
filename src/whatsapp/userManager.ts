import crypto from 'crypto'
import db from '../db'
import { createCustodialWallet, getWalletByUserId } from '../stellar/wallet'
import {
  getGoalForUser,
  computeGoalProgress,
  GoalProgress,
} from '../goals/service'

/**
 * A WhatsApp user, identified by phone number, with a custodial wallet
 * and an optional pending one-time password (OTP) for verification.
 */
export type WhatsAppUser = {
  id: string
  phone: string // Normalized phone number (no "whatsapp:" prefix)
  verified: boolean // True once the user has completed OTP verification
  walletAddress: string // Public key of the user's custodial Stellar wallet
  balance: number // In-memory balance tracked for this user
  // Pending OTP, present only between generateOtp() and a successful/expired verifyOtp()
  otp?: {
    code: string
    expiresAt: number // Unix timestamp in milliseconds
  }
}

/**
 * Aggregated yield stats across all of a user's active positions.
 */
export type PortfolioYieldSummary = {
  totalBalance: number // Sum of current value across active positions
  totalEarnings: number // Lifetime yield earned across active positions
  periodEarnings: number // Yield earned over the last 30 days
  averageApy: number // Average APY (from snapshots, or latest protocol rates as fallback)
}

// In-memory user store, keyed by normalized phone number (replace with DB in production)
const userStore = new Map<string, WhatsAppUser>()

// How long an OTP stays valid after it is generated
const OTP_TTL_MS = 1000 * 60 * 5 // 5 minutes

/**
 * Normalize WhatsApp phone identifiers (e.g. whatsapp:+1234567890) into a stable key.
 * Strips the "whatsapp:" prefix (case-insensitive) and surrounding whitespace.
 */
export function normalizePhone(phone: string): string {
  return phone.replace(/^whatsapp:/i, '').trim()
}

/**
 * Look up a user by phone number. Returns null if no such user exists.
 */
export function getUserByPhone(phone: string): WhatsAppUser | null {
  const normalized = normalizePhone(phone)
  return userStore.get(normalized) ?? null
}

/**
 * Return the existing user for this phone number, or create a new one
 * (with a fresh custodial wallet) if none exists yet.
 */
export async function createOrGetUser(phone: string): Promise<WhatsAppUser> {
  const normalized = normalizePhone(phone)

  // Return the existing user so we never create a second wallet for the same phone
  const existing = userStore.get(normalized)
  if (existing) {
    return existing
  }

  // New user: generate an ID and provision a custodial wallet tied to it
  const userId = crypto.randomUUID()
  const wallet = await createCustodialWallet(userId)

  // New users start unverified with a zero balance
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

/**
 * Generate a 6-digit OTP for the user and store it with an expiry time.
 * Throws if the user does not exist. Overwrites any previous pending OTP.
 *
 * NOTE: Math.random() is not cryptographically secure; consider
 * crypto.randomInt(100000, 1000000) for production use.
 */
export function generateOtp(phone: string): string {
  const user = getUserByPhone(phone)
  if (!user) {
    throw new Error('User not found')
  }

  // Random integer in the range 100000-999999, so it is always exactly 6 digits
  const code = Math.floor(100000 + Math.random() * 900000).toString()
  user.otp = {
    code,
    expiresAt: Date.now() + OTP_TTL_MS,
  }

  // Update store for reference
  userStore.set(user.phone, user)

  return code
}

/**
 * Check a submitted OTP against the stored one.
 * Returns true (and marks the user verified) only if the code matches and has not expired.
 * The OTP is cleared on success and on expiry, but not on a wrong guess.
 *
 * NOTE: There is no limit on failed attempts, so a 6-digit code could be
 * brute-forced; consider adding attempt limiting.
 */
export function verifyOtp(phone: string, code: string): boolean {
  const user = getUserByPhone(phone)
  // Fail if the user is unknown or never requested an OTP
  if (!user || !user.otp) {
    return false
  }

  // Expired: discard the OTP so it cannot be reused, and reject
  const now = Date.now()
  if (now > user.otp.expiresAt) {
    delete user.otp
    userStore.set(user.phone, user)
    return false
  }

  // Wrong code: reject but leave the OTP in place so the user can retry
  if (user.otp.code !== code) {
    return false
  }

  // Correct and in time: mark verified and consume the OTP (single use)
  user.verified = true
  delete user.otp
  userStore.set(user.phone, user)
  return true
}

/**
 * Get the user's public wallet address, or null if the user does not exist.
 */
export function getUserWalletAddress(phone: string): string | null {
  const user = getUserByPhone(phone)
  if (!user) return null
  return user.walletAddress
}

/**
 * Get the user's in-memory balance, or null if the user does not exist.
 */
export function getBalance(phone: string): number | null {
  const user = getUserByPhone(phone)
  return user ? user.balance : null
}

/**
 * Build a yield summary for the user's active positions.
 *
 * - Returns null if the user is unknown.
 * - Returns zeroed earnings (with the in-memory balance) if the user has no DB
 *   record or no active positions.
 * - Period earnings cover the last 30 days. Average APY comes from yield
 *   snapshots in that window, falling back to the latest protocol supply rates
 *   when no snapshots exist.
 */
export async function getPortfolioYieldSummary(
  phone: string
): Promise<PortfolioYieldSummary | null> {
  const user = getUserByPhone(phone)
  if (!user) {
    return null
  }

  // Map the wallet address to the database user record
  const dbUser = await db.user.findUnique({
    where: { walletAddress: user.walletAddress },
    select: { id: true },
  })

  // No DB record yet: nothing has been earned, so report only the in-memory balance
  if (!dbUser) {
    return {
      totalBalance: user.balance,
      totalEarnings: 0,
      periodEarnings: 0,
      averageApy: 0,
    }
  }

  // Fetch only active positions, with the fields needed for totals and rate lookups
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

  // No active positions: same zeroed summary as above
  if (positions.length === 0) {
    return {
      totalBalance: user.balance,
      totalEarnings: 0,
      periodEarnings: 0,
      averageApy: 0,
    }
  }

  // Reporting window: the last 30 days
  const fromDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  const positionIds = positions.map((position) => position.id)

  // Run both queries in parallel since they are independent:
  //  - yield snapshots for these positions within the window
  //  - protocol rates for each (protocol, asset) pair, newest first
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

  // Totals across active positions (Number() converts DB decimal types)
  const totalBalance = positions.reduce(
    (sum, position) => sum + Number(position.currentValue),
    0
  )
  const totalEarnings = positions.reduce(
    (sum, position) => sum + Number(position.yieldEarned),
    0
  )
  // Yield earned within the 30-day window
  const periodEarnings = snapshots.reduce(
    (sum, snapshot) => sum + Number(snapshot.yieldAmount),
    0
  )

  let averageApy = 0
  if (snapshots.length > 0) {
    // Preferred source: simple mean of APY across recent snapshots
    averageApy =
      snapshots.reduce((sum, snapshot) => sum + Number(snapshot.apy), 0) /
      snapshots.length
  } else {
    // Fallback: use the most recent supply APY for each (protocol, asset) pair.
    // Rates are sorted newest first, so the first one seen per pair is the latest.
    const latestRatesByPair = new Map<string, number>()
    for (const rate of protocolRates) {
      const key = `${rate.protocolName}:${rate.assetSymbol}`
      if (!latestRatesByPair.has(key)) {
        latestRatesByPair.set(key, Number(rate.supplyApy))
      }
    }

    // Simple mean across pairs (not weighted by position size)
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

/**
 * Subtract from the user's balance and return the new value.
 * Throws if the user does not exist. The balance is floored at 0, so
 * overdrawing silently clamps instead of failing.
 */
export function decrementBalance(phone: string, amount: number): number {
  const user = getUserByPhone(phone)
  if (!user) {
    throw new Error('User not found')
  }
  user.balance = Math.max(0, user.balance - amount)
  userStore.set(user.phone, user)
  return user.balance
}

// --- Test helpers ---

/**
 * Test-only accessor for a user record (e.g. to read the pending OTP).
 */
export function getUserForTests(phone: string): WhatsAppUser | null {
  return getUserByPhone(phone)
}

/**
 * Test-only reset: wipes the in-memory user store between tests.
 */
export function clearUsersForTests(): void {
  userStore.clear()
}

/**
 * Confirm the user's wallet can be loaded and decrypted from the wallet store.
 * Throws if the user does not exist.
 */
export async function ensureWalletDecrypted(phone: string) {
  const user = getUserByPhone(phone)
  if (!user) throw new Error('User not found')

  // Read from wallet store to ensure decryption works.
  // This is used in tests to ensure secret keys are not stored in plaintext.
  await getWalletByUserId(user.id)
}
