import crypto from 'crypto'
import { createCustodialWallet } from '../stellar/wallet'

export type TelegramUser = {
  id: string
  chatId: string
  linked: boolean
  walletAddress: string
  balance: number
}

const userStore = new Map<string, TelegramUser>()

const linkCodeTtlMs = 10 * 60 * 1000
const linkCodes = new Map<
  string,
  { code: string; chatId: string; expiresAt: number; used: boolean }
>()

export function clearTelegramUsersForTests(): void {
  userStore.clear()
  linkCodes.clear()
}

export function getTelegramUser(chatId: string): TelegramUser | null {
  return userStore.get(`chat:${chatId}`) ?? null
}

export async function createOrGetTelegramUser(
  chatId: string
): Promise<TelegramUser> {
  const existing = getTelegramUser(chatId)
  if (existing) return existing

  const userId = crypto.randomUUID()
  const wallet = await createCustodialWallet(userId)
  const user: TelegramUser = {
    id: userId,
    chatId,
    linked: false,
    walletAddress: wallet.publicKey,
    balance: 0,
  }

  userStore.set(`chat:${chatId}`, user)
  return user
}

export function createLinkCode(chatId: string): string {
  const code = `TLG-${Math.random().toString(36).slice(2, 8).toUpperCase()}`
  linkCodes.set(code, {
    code,
    chatId,
    expiresAt: Date.now() + linkCodeTtlMs,
    used: false,
  })
  return code
}

export function consumeLinkCode(code: string): string | null {
  const record = linkCodes.get(code)
  if (!record || record.used) return null

  if (Date.now() > record.expiresAt) {
    linkCodes.delete(code)
    return null
  }

  record.used = true
  linkCodes.set(code, record)
  return record.chatId
}

export async function linkTelegramChat(
  chatId: string,
  code: string
): Promise<TelegramUser> {
  const linkedChatId = consumeLinkCode(code)
  if (!linkedChatId) {
    throw new Error('Invalid or expired link code')
  }

  const user = await createOrGetTelegramUser(chatId)
  user.linked = true
  userStore.set(`chat:${chatId}`, user)
  return user
}

export function getUserWalletAddress(chatId: string): string | null {
  return getTelegramUser(chatId)?.walletAddress ?? null
}

export function getBalance(chatId: string): number | null {
  return getTelegramUser(chatId)?.balance ?? null
}

export function decrementBalance(chatId: string, amount: number): number {
  const user = getTelegramUser(chatId)
  if (!user) throw new Error('User not found')
  user.balance = Math.max(0, user.balance - amount)
  userStore.set(`chat:${chatId}`, user)
  return user.balance
}

export function getUserForTests(chatId: string): TelegramUser | null {
  return getTelegramUser(chatId)
}
