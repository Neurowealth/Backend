#!/usr/bin/env ts-node
/**
 * Backfill CustodialWallet.encryptionKeyId provenance (#323)
 *
 * Existing custodial_wallets rows predate row-level key provenance and have
 * encryptionKeyId = null, so they're read via the legacy try-primary-
 * then-fallback heuristic in src/stellar/wallet.ts. This script attempts
 * decryption of every such row with the active key, then the fallback key
 * (if configured), verifies the derived public key matches the stored one,
 * and records which key registry entry owns the row.
 *
 * Deterministic and idempotent: only rows with encryptionKeyId = null are
 * considered, so interrupting and re-running just resumes with whatever is
 * left. A row that decrypts with neither key is quarantined (left untouched,
 * reported) rather than aborting the whole run.
 *
 * Usage:
 *   npx ts-node scripts/backfill-wallet-key-provenance.ts [--dry-run]
 *
 * Environment:
 *   - DATABASE_URL
 *   - WALLET_ENCRYPTION_KEY (required, 64 hex chars)
 *   - WALLET_ENCRYPTION_KEY_OLD (optional, 64 hex chars — rows still on a
 *     previously-retired key are matched against this)
 */

import { Keypair } from '@stellar/stellar-sdk'
import db from '../src/db'
import { logger } from '../src/utils/logger'
import { decryptSecretWithKey } from '../src/stellar/wallet'
import { getOrRegisterKey, deriveBootstrapLabel } from '../src/keys/registry'

const BATCH_SIZE = 500
const DRY_RUN = process.argv.includes('--dry-run')
const HEX_64_REGEX = /^[0-9a-fA-F]{64}$/

function requireHexKey(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  if (!HEX_64_REGEX.test(value)) {
    throw new Error(`${name} must be 64 hexadecimal characters (32 bytes)`)
  }
  return value
}

function readOptionalHexKey(name: string): string | undefined {
  const value = process.env[name]
  if (!value) return undefined
  if (!HEX_64_REGEX.test(value)) {
    throw new Error(`${name} must be 64 hexadecimal characters (32 bytes)`)
  }
  return value
}

async function main(): Promise<void> {
  const activeKeyHex = requireHexKey('WALLET_ENCRYPTION_KEY')
  const fallbackKeyHex = readOptionalHexKey('WALLET_ENCRYPTION_KEY_OLD')

  logger.info('[Key Provenance Backfill] Starting', {
    dryRun: DRY_RUN,
    fallbackConfigured: Boolean(fallbackKeyHex),
  })

  const activeKey = await getOrRegisterKey(
    activeKeyHex,
    deriveBootstrapLabel(activeKeyHex),
    'ACTIVE'
  )
  const fallbackKey = fallbackKeyHex
    ? await getOrRegisterKey(
        fallbackKeyHex,
        deriveBootstrapLabel(fallbackKeyHex),
        'RETIRED'
      )
    : undefined

  let backfilledActive = 0
  let backfilledFallback = 0
  let quarantined = 0
  const quarantinedRows: { id: string; userId: string }[] = []

  let cursor: string | undefined
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const batch = await db.custodialWallet.findMany({
      where: { encryptionKeyId: null },
      take: BATCH_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
    })
    if (batch.length === 0) break
    cursor = batch[batch.length - 1].id

    for (const wallet of batch) {
      let matchedKeyId: string | undefined
      let matchedLabel: 'active' | 'fallback' | undefined

      try {
        const secret = decryptSecretWithKey(
          wallet.encryptedSecret,
          wallet.iv,
          wallet.authTag,
          activeKeyHex
        )
        if (Keypair.fromSecret(secret).publicKey() === wallet.publicKey) {
          matchedKeyId = activeKey.id
          matchedLabel = 'active'
        }
      } catch {
        // Not decryptable with the active key — try the fallback below.
      }

      if (!matchedKeyId && fallbackKeyHex && fallbackKey) {
        try {
          const secret = decryptSecretWithKey(
            wallet.encryptedSecret,
            wallet.iv,
            wallet.authTag,
            fallbackKeyHex
          )
          if (Keypair.fromSecret(secret).publicKey() === wallet.publicKey) {
            matchedKeyId = fallbackKey.id
            matchedLabel = 'fallback'
          }
        } catch {
          // Not decryptable with the fallback key either — quarantine below.
        }
      }

      if (!matchedKeyId) {
        quarantined++
        quarantinedRows.push({ id: wallet.id, userId: wallet.userId })
        logger.warn(
          '[Key Provenance Backfill] Quarantined row: decrypts with neither the active nor fallback key',
          { walletId: wallet.id }
        )
        continue
      }

      if (!DRY_RUN) {
        await db.custodialWallet.update({
          where: { id: wallet.id },
          data: { encryptionKeyId: matchedKeyId },
        })
      }

      if (matchedLabel === 'active') backfilledActive++
      else backfilledFallback++
    }
  }

  logger.info('[Key Provenance Backfill] Complete', {
    dryRun: DRY_RUN,
    backfilledActive,
    backfilledFallback,
    quarantined,
  })

  if (quarantined > 0) {
    console.log('')
    console.log(
      `⚠️  ${quarantined} row(s) could not be matched to a known key and were left untouched:`
    )
    quarantinedRows
      .slice(0, 20)
      .forEach((r) => console.log(`   - wallet ${r.id} (user ${r.userId})`))
    if (quarantinedRows.length > 20) {
      console.log(`   ... and ${quarantinedRows.length - 20} more`)
    }
    process.exitCode = 1
  }
}

main()
  .catch((err) => {
    logger.error('[Key Provenance Backfill] Failed', {
      error: err instanceof Error ? err.message : String(err),
    })
    process.exitCode = 1
  })
  .finally(() => db.$disconnect())
