import * as crypto from 'crypto'
import db from '../db'
import type { KeyStatus, WalletEncryptionKey } from '@prisma/client'

const HEX_64_REGEX = /^[0-9a-fA-F]{64}$/

/**
 * SHA-256 of the raw hex key. The registry stores this and a label only —
 * never the key material itself — so a CustodialWallet row's
 * `encryptionKeyId` can prove which key encrypted it without the registry
 * ever holding anything an attacker could decrypt with.
 */
export function hashKey(keyHex: string): string {
  return crypto.createHash('sha256').update(keyHex, 'hex').digest('hex')
}

/** A deterministic, collision-free label for a key that has no operator-assigned
 * one yet (e.g. auto-registered from an env var at read time). Derived from the
 * key's own hash so it is stable across repeated calls for the same key without
 * ever encoding the key material itself. */
export function deriveBootstrapLabel(keyHex: string): string {
  return `bootstrap-${hashKey(keyHex).slice(0, 12)}`
}

export async function findKeyByHash(
  hash: string
): Promise<WalletEncryptionKey | null> {
  return db.walletEncryptionKey.findUnique({ where: { hash } })
}

export async function findKeyById(
  id: string
): Promise<WalletEncryptionKey | null> {
  return db.walletEncryptionKey.findUnique({ where: { id } })
}

export async function listKeys(): Promise<WalletEncryptionKey[]> {
  return db.walletEncryptionKey.findMany({ orderBy: { createdAt: 'asc' } })
}

/**
 * Register a key's metadata in the registry if it isn't already tracked
 * (looked up by hash). Idempotent: safe to call on every process start or
 * every wallet read — returns the existing row rather than erroring if the
 * key is already registered under a different label.
 */
export async function getOrRegisterKey(
  keyHex: string,
  keyLabel: string,
  status: KeyStatus = 'ACTIVE'
): Promise<WalletEncryptionKey> {
  if (!keyHex || !HEX_64_REGEX.test(keyHex)) {
    throw new Error(
      'getOrRegisterKey: key must be 64 hexadecimal characters (32 bytes)'
    )
  }

  const hash = hashKey(keyHex)
  const existing = await findKeyByHash(hash)
  if (existing) return existing

  try {
    return await db.walletEncryptionKey.create({
      data: { keyLabel, hash, status },
    })
  } catch (err) {
    // Two concurrent callers can both miss the findKeyByHash lookup at cold
    // start and race to create the same row; the loser hits the unique
    // constraint on `hash`. Re-read and return the winner's row instead of
    // failing the caller.
    const existingAfterRace = await findKeyByHash(hash)
    if (existingAfterRace) return existingAfterRace
    throw err
  }
}

export async function retireKey(id: string): Promise<WalletEncryptionKey> {
  return db.walletEncryptionKey.update({
    where: { id },
    data: { status: 'RETIRED', retiredAt: new Date() },
  })
}

export async function markCompromised(
  id: string
): Promise<WalletEncryptionKey> {
  return db.walletEncryptionKey.update({
    where: { id },
    data: { status: 'COMPROMISED' },
  })
}
