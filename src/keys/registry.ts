import * as crypto from 'crypto'
import db from '../db'
import type { KeyStatus, WalletEncryptionKey } from '@prisma/client'

const HEX_64_REGEX = /^[0-9a-fA-F]{64}$/
const AES_ALGO = 'aes-256-gcm'
const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16

/**
 * Resolve the active encryption key material used to encrypt sensitive
 * secrets at rest (e.g. TOTP secrets). Reuses the same env-var pattern the
 * wallet encryption key registry is bootstrapped from, so there is a single
 * source of truth for the at-rest encryption key.
 */
export function getActiveEncryptionKeyHex(): string {
  const keyHex =
    process.env.WALLET_ENCRYPTION_KEY ||
    process.env.ENCRYPTION_KEY ||
    process.env.KEY_ENCRYPTION_KEY
  if (!keyHex || !HEX_64_REGEX.test(keyHex)) {
    throw new Error(
      'getActiveEncryptionKeyHex: no valid 64-hex encryption key configured'
    )
  }
  return keyHex
}

/**
 * Encrypt a UTF-8 plaintext secret with AES-256-GCM using the active
 * encryption key. Returns a self-describing payload of
 * `iv:authTag:ciphertext` (all hex) so it can be stored in a single column
 * and decrypted without any out-of-band metadata. The plaintext is never
 * logged or returned by callers.
 */
export function encryptSecret(plaintext: string): string {
  const key = Buffer.from(getActiveEncryptionKeyHex(), 'hex')
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv(AES_ALGO, key, iv)
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ])
  const authTag = cipher.getAuthTag()
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`
}

/**
 * Decrypt a payload produced by `encryptSecret`. Throws on tampering or a
 * key mismatch (GCM auth tag failure) rather than returning garbage.
 */
export function decryptSecret(payload: string): string {
  const parts = payload.split(':')
  if (parts.length !== 3) {
    throw new Error('decryptSecret: malformed encrypted payload')
  }
  const [ivHex, authTagHex, ciphertextHex] = parts
  const iv = Buffer.from(ivHex, 'hex')
  const authTag = Buffer.from(authTagHex, 'hex')
  if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error('decryptSecret: malformed encrypted payload')
  }
  const key = Buffer.from(getActiveEncryptionKeyHex(), 'hex')
  const decipher = crypto.createDecipheriv(AES_ALGO, key, iv)
  decipher.setAuthTag(authTag)
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, 'hex')),
    decipher.final(),
  ])
  return plaintext.toString('utf8')
}

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
