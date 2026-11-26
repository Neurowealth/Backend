/**
 * Backfill script: migrate TOTP credentials from plaintext base64 to AES-256-GCM encryption.
 *
 * This script:
 * 1. Finds all TotpCredential rows with empty iv/authTag (indicating plaintext base64 storage)
 * 2. Re-encrypts each secret using encryptSecret() from the key registry
 * 3. Updates the database with proper encrypted payloads
 *
 * Safe to run multiple times (idempotent) — already-migrated rows are skipped.
 *
 * Usage:
 *   npx tsx scripts/backfill-totp-encryption.ts
 */

import db from '../src/db'
import { encryptSecret, decryptSecret } from '../src/keys/registry'
import { logger } from '../src/utils/logger'

async function main() {
  logger.info('[Backfill] Starting TOTP encryption migration')

  // Find all credentials with empty iv/authTag (plaintext base64)
  const plaintextCredentials = await db.totpCredential.findMany({
    where: {
      OR: [
        { iv: '' },
        { authTag: '' },
      ],
    },
    select: {
      id: true,
      userId: true,
      secretEncrypted: true,
      iv: true,
      authTag: true,
    },
  })

  if (plaintextCredentials.length === 0) {
    logger.info('[Backfill] No plaintext credentials found — all secrets are already encrypted')
    return
  }

  logger.info(`[Backfill] Found ${plaintextCredentials.length} plaintext credentials to migrate`)

  let successCount = 0
  let errorCount = 0

  for (const credential of plaintextCredentials) {
    try {
      const { id, userId, secretEncrypted, iv, authTag } = credential

      // Double-check this is a plaintext credential
      if (iv !== '' && authTag !== '') {
        logger.debug(`[Backfill] Skipping credential ${id} — already encrypted`)
        continue
      }

      // The existing secretEncrypted is base64-encoded raw bytes
      // We need to re-encrypt it using encryptSecret()
      const reEncrypted = encryptSecret(secretEncrypted)

      // Verify we can decrypt it back
      const decrypted = decryptSecret(reEncrypted)
      if (decrypted !== secretEncrypted) {
        throw new Error('Encryption round-trip verification failed')
      }

      // Update the database with the properly encrypted payload
      await db.totpCredential.update({
        where: { id },
        data: {
          secretEncrypted: reEncrypted,
          // Clear iv/authTag since they're now embedded in the payload
          iv: '',
          authTag: '',
        },
      })

      successCount++
      logger.debug(`[Backfill] Successfully migrated credential for user ${userId}`)
    } catch (err) {
      errorCount++
      logger.error(`[Backfill] Failed to migrate credential ${credential.id}`, {
        error: err instanceof Error ? err.message : String(err),
        userId: credential.userId,
      })
    }
  }

  logger.info('[Backfill] Migration complete', {
    total: plaintextCredentials.length,
    success: successCount,
    errors: errorCount,
  })

  if (errorCount > 0) {
    throw new Error(`Migration completed with ${errorCount} errors`)
  }
}

main()
  .catch((err) => {
    logger.error('[Backfill] Fatal error', { error: err })
    process.exit(1)
  })
  .finally(() => {
    db.$disconnect()
  })
