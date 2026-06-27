import { Keypair } from '@stellar/stellar-sdk';
import * as crypto from 'crypto';
import db from '../db';
import { logger } from '../utils/logger';

const ALGORITHM = 'aes-256-gcm';
const HEX_64_REGEX = /^[0-9a-fA-F]{64}$/;

/**
 * Validate that a value is exactly 64 hex characters (32 bytes).
 * Throws with a clear, labeled message on failure.
 *
 * This matters because Buffer.from(str, 'hex') does NOT throw on invalid
 * hex input — it silently stops parsing at the first bad character and
 * returns a truncated (or differently-valued) buffer. A length-only check
 * can let a malformed key through and fail later with a confusing
 * "Invalid key length" error from the cipher, or worse, silently use the
 * wrong key bytes if the truncation happens to land on a 32-byte boundary.
 */
function assertValidHexKey(value: string, label: string): void {
  if (!value || value.length !== 64) {
    throw new Error(`${label} must be 64 hex characters (32 bytes)`);
  }
  if (!HEX_64_REGEX.test(value)) {
    throw new Error(`${label} must contain only hexadecimal characters (0-9, a-f, A-F)`);
  }
}

/**
 * Get the primary encryption key from environment.
 * Must be 64 hex characters (32 bytes).
 */
function getEncryptionKey(): string {
  const key = process.env.WALLET_ENCRYPTION_KEY || '';
  assertValidHexKey(key, 'WALLET_ENCRYPTION_KEY');
  return key;
}

/**
 * Get the fallback encryption key for dual-key reads during rotation.
 * Optional: set WALLET_ENCRYPTION_KEY_OLD to enable fallback decryption.
 * Returns undefined if not configured or invalid (logs a warning in that case
 * rather than throwing, since a bad fallback key shouldn't break primary reads).
 */
function getFallbackEncryptionKey(): string | undefined {
  const key = process.env.WALLET_ENCRYPTION_KEY_OLD;
  if (!key) return undefined;

  try {
    assertValidHexKey(key, 'WALLET_ENCRYPTION_KEY_OLD');
  } catch (err) {
    logger.warn(
      `WALLET_ENCRYPTION_KEY_OLD invalid; ignoring fallback key: ${err instanceof Error ? err.message : 'unknown error'}`
    );
    return undefined;
  }

  return key;
}

function encryptSecret(secret: string): { encrypted: string; iv: string; authTag: string } {
  const key = Buffer.from(getEncryptionKey(), 'hex');
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(secret, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  return {
    encrypted,
    iv: iv.toString('hex'),
    authTag: cipher.getAuthTag().toString('hex'),
  };
}

/**
 * Decrypt a secret with the primary key.
 * Throws if decryption fails.
 */
function decryptSecret(encrypted: string, iv: string, authTag: string): string {
  const key = Buffer.from(getEncryptionKey(), 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(authTag, 'hex'));

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Decrypt a secret with dual-key support.
 * Tries the primary key first; if that fails and a fallback key is configured,
 * attempts decryption with the fallback key.
 *
 * Returns: { secret, keyUsed: 'primary' | 'fallback' }
 * Throws if both keys fail or no keys are available.
 */
function decryptSecretDualKey(
  encrypted: string,
  iv: string,
  authTag: string
): { secret: string; keyUsed: 'primary' | 'fallback' } {
  // Try primary key
  try {
    const key = Buffer.from(getEncryptionKey(), 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'hex'));
    decipher.setAuthTag(Buffer.from(authTag, 'hex'));

    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return { secret: decrypted, keyUsed: 'primary' };
  } catch (err) {
    // Try fallback key if available
    const fallbackKey = getFallbackEncryptionKey();
    if (!fallbackKey) {
      throw new Error(`Decryption with primary key failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    }

    try {
      const key = Buffer.from(fallbackKey, 'hex');
      const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'hex'));
      decipher.setAuthTag(Buffer.from(authTag, 'hex'));

      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      logger.info('[Wallet] Decrypted with fallback key; consider re-encrypting with primary key');
      return { secret: decrypted, keyUsed: 'fallback' };
    } catch (fallbackErr) {
      throw new Error(
        `Decryption failed with both primary and fallback keys: ${fallbackErr instanceof Error ? fallbackErr.message : 'unknown error'}`
      );
    }
  }
}

/**
 * Create a custodial wallet for a user and persist it to the database.
 *
 * SECURITY NOTE: This is a custodial solution where the backend holds user keys.
 * Users trust the backend to secure their funds. Consider non-custodial alternatives
 * for production use cases requiring higher security guarantees.
 *
 * Key rotation / backup: rotate WALLET_ENCRYPTION_KEY using
 * scripts/rotate-wallet-key.ts, which re-encrypts all rows with the new key.
 * See the key-rotation runbook for the full backup -> rotate -> verify ->
 * rollback procedure. Back up the database regularly; losing the encryption
 * key means wallets cannot be recovered.
 */
export async function createCustodialWallet(userId: string) {
  const existing = await db.custodialWallet.findUnique({ where: { userId } });
  if (existing) {
    throw new Error(`Wallet already exists for user ${userId}`);
  }

  const keypair = Keypair.random();
  const { encrypted, iv, authTag } = encryptSecret(keypair.secret());

  const wallet = await db.custodialWallet.create({
    data: {
      userId,
      publicKey: keypair.publicKey(),
      encryptedSecret: encrypted,
      iv,
      authTag,
      keyVersion: 2,
    },
  });

  logger.info(`[Wallet] Created for user ${userId}: ${wallet.publicKey}`);
  return wallet;
}

/**
 * Get wallet record by user ID.
 */
export async function getWalletByUserId(userId: string) {
  return db.custodialWallet.findUnique({ where: { userId } });
}

/**
 * Decrypt and return the Stellar Keypair for a user.
 * Supports dual-key reads if WALLET_ENCRYPTION_KEY_OLD is configured.
 */
export async function getKeypairForUser(userId: string): Promise<Keypair> {
  const wallet = await getWalletByUserId(userId);

  if (!wallet) {
    throw new Error(`No wallet found for user ${userId}`);
  }

  // Use dual-key decryption for smooth key rotation support
  const { secret, keyUsed } = decryptSecretDualKey(
    wallet.encryptedSecret,
    wallet.iv,
    wallet.authTag
  );

  if (keyUsed === 'fallback') {
    logger.debug(`[Wallet] User ${userId} decrypted with fallback key; schedule re-encryption`);
  }

  // Lazy re-encryption for wallets on v1
  if (wallet.keyVersion === 1) {
    try {
      const { encrypted, iv, authTag } = encryptSecret(secret);
      await db.custodialWallet.update({
        where: { id: wallet.id },
        data: {
          encryptedSecret: encrypted,
          iv,
          authTag,
          keyVersion: 2,
        },
      });
      logger.info(`[Wallet] Upgraded user ${userId} to keyVersion 2 via lazy re-encryption`);
    } catch (err) {
      logger.error(`[Wallet] Failed to lazy re-encrypt user ${userId}: ${err instanceof Error ? err.message : 'unknown error'}`);
      // Non-fatal, we still return the keypair
    }
  }

  return Keypair.fromSecret(secret);
}

/**
 * List all wallet public keys (for admin/debugging).
 */
export async function listWallets(): Promise<string[]> {
  const wallets = await db.custodialWallet.findMany({ select: { publicKey: true } });
  return wallets.map(w => w.publicKey);
}

/**
 * Internal utility: Decrypt with primary key only (for rotation tooling).
 * Throws if decryption fails — does not fall back to old key.
 */
export function decryptSecretWithPrimaryKey(
  encrypted: string,
  iv: string,
  authTag: string
): string {
  return decryptSecret(encrypted, iv, authTag);
}

/**
 * Internal utility: Decrypt with dual-key support.
 *
 * Exported wrapper around the internal dual-key decrypt logic, for use by
 * tooling or tests that need fallback decryption without reaching into
 * module internals. Note: getKeypairForUser above calls decryptSecretDualKey
 * directly rather than through this wrapper — both behave identically.
 */
export function decryptSecretWithFallback(
  encrypted: string,
  iv: string,
  authTag: string
): { secret: string; keyUsed: 'primary' | 'fallback' } {
  return decryptSecretDualKey(encrypted, iv, authTag);
}

/**
 * Internal utility: Create encrypted wallet data with a specified key.
 *
 * Intended for rotation tooling that wants to reuse this service's
 * encryption logic rather than reimplementing it. The bundled CLI script
 * (scripts/rotate-wallet-key.ts) currently keeps its own small,
 * self-contained encrypt/decrypt helpers so it has no runtime dependency on
 * application internals — if you'd rather have a single source of truth for
 * the crypto, wire the script up to import this function instead.
 */
export function createEncryptedSecretWithKey(
  secret: string,
  keyHex: string
): { encrypted: string; iv: string; authTag: string } {
  assertValidHexKey(keyHex, 'Key');

  const key = Buffer.from(keyHex, 'hex');
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(secret, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  return {
    encrypted,
    iv: iv.toString('hex'),
    authTag: cipher.getAuthTag().toString('hex'),
  };
}