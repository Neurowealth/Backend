#!/usr/bin/env ts-node
/**
 * Custodial Wallet Key Rotation CLI
 *
 * Rotates WALLET_ENCRYPTION_KEY by re-encrypting all custodial_wallets rows.
 *
 * Usage:
 *   npx ts-node scripts/rotate-wallet-key.ts --old-key <hex> --new-key <hex> [--dry-run]
 *   npx ts-node scripts/rotate-wallet-key.ts --verify --key <hex>
 *
 * Preferred over CLI flags (flags land in shell history and `ps aux`):
 *   WALLET_ROTATION_OLD_KEY=<hex> WALLET_ROTATION_NEW_KEY=<hex> \
 *     npx ts-node scripts/rotate-wallet-key.ts --skip-confirm
 *
 * If neither flags nor env vars are supplied, the script prompts
 * interactively with input masked (falls back to plain prompts if stdin
 * isn't a TTY, e.g. when piped in CI).
 *
 * Environment:
 *   - Database connection required via DATABASE_URL
 *   - Both keys must be 64 hex characters (32 bytes)
 */

import { PrismaClient } from '@prisma/client';
import * as crypto from 'crypto';
import * as path from 'path';
import * as readline from 'readline';
import {
  RotationMetrics,
  initializeMetrics,
  finalizeMetrics,
  recordError,
  recordSuccess,
  calculateProgress,
  saveMetricsToFile,
  saveDryRunReport,
  formatMetricsSummary,
  logRotationProgress,
} from './rotation-metrics';

const ALGORITHM = 'aes-256-gcm';
const HEX_64_REGEX = /^[0-9a-fA-F]{64}$/;
const BATCH_SIZE = 500;
const METRICS_OUTPUT_DIR = path.join(process.cwd(), 'logs', 'wallet-rotation');

// ─────────────────────────────────────────────────────────────────────────────
// Utility Functions
// ─────────────────────────────────────────────────────────────────────────────

function validateHexKey(key: string, label: string): boolean {
  if (!key || key.length !== 64) {
    console.error(`❌ ${label}: must be 64 hex characters (32 bytes). Got ${key?.length || 0} chars.`);
    return false;
  }
  if (!HEX_64_REGEX.test(key)) {
    console.error(`❌ ${label}: must be valid hexadecimal.`);
    return false;
  }
  return true;
}

function decryptSecret(
  encrypted: string,
  iv: string,
  authTag: string,
  key: Buffer
): string {
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'hex'));
    decipher.setAuthTag(Buffer.from(authTag, 'hex'));

    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } catch (err) {
    throw new Error(`Decryption failed: ${err instanceof Error ? err.message : 'unknown error'}`);
  }
}

function encryptSecret(
  secret: string,
  key: Buffer
): { encrypted: string; iv: string; authTag: string } {
  try {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(secret, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    return {
      encrypted,
      iv: iv.toString('hex'),
      authTag: cipher.getAuthTag().toString('hex'),
    };
  } catch (err) {
    throw new Error(`Encryption failed: ${err instanceof Error ? err.message : 'unknown error'}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Interactive Prompts
// ─────────────────────────────────────────────────────────────────────────────

function createReadlineInterface(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

async function promptYesNo(question: string): Promise<boolean> {
  const rl = createReadlineInterface();
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

async function promptForInput(question: string): Promise<string> {
  const rl = createReadlineInterface();
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Prompt for a secret value without echoing it to the terminal.
 * Falls back to a plain (visible) prompt when stdin isn't an interactive
 * TTY — e.g. when input is piped, or in most CI environments.
 */
async function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void };

  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    return promptForInput(question);
  }

  return new Promise((resolve) => {
    process.stdout.write(question);
    stdin.setRawMode!(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let input = '';

    const cleanup = () => {
      stdin.setRawMode!(false);
      stdin.pause();
      stdin.removeListener('data', onData);
    };

    const onData = (chunk: string) => {
      const char = chunk.toString();
      switch (char) {
        case '\n':
        case '\r':
        case '\u0004': // Ctrl-D
          cleanup();
          process.stdout.write('\n');
          resolve(input.trim());
          break;
        case '\u0003': // Ctrl-C
          cleanup();
          process.stdout.write('\n');
          process.exit(1);
          break;
        case '\u007f': // DEL
        case '\b': // BS
          if (input.length > 0) {
            input = input.slice(0, -1);
            process.stdout.write('\b \b');
          }
          break;
        default:
          input += char;
          process.stdout.write('*');
          break;
      }
    };

    stdin.on('data', onData);
  });
}

function printHelp(): void {
  console.log(`
Usage: npx ts-node scripts/rotate-wallet-key.ts [options]

Rotate mode (default):
  --old-key <hex>      The current WALLET_ENCRYPTION_KEY (64 hex chars)
  --new-key <hex>      The new WALLET_ENCRYPTION_KEY (64 hex chars)
  --dry-run            Validate rotation without making changes (saves report to logs/wallet-rotation/)
  --skip-confirm       Skip confirmation prompts

Verify mode:
  --verify             Check that all wallets decrypt with a given key
  --key <hex>          The key to verify against (64 hex chars)

  --help, -h           Show this help message

Preferred env vars (avoid leaking keys via shell history / ps):
  WALLET_ROTATION_OLD_KEY, WALLET_ROTATION_NEW_KEY

Examples:
  # Dry run to validate rotation
  npx ts-node scripts/rotate-wallet-key.ts --old-key abc123... --new-key def456... --dry-run

  # Perform rotation with confirmation
  npx ts-node scripts/rotate-wallet-key.ts --old-key abc123... --new-key def456...

  # Perform rotation without confirmation (CI/automation)
  WALLET_ROTATION_OLD_KEY=abc123... WALLET_ROTATION_NEW_KEY=def456... \\
    npx ts-node scripts/rotate-wallet-key.ts --skip-confirm

  # After rotation, confirm every row now decrypts with the new key alone
  npx ts-node scripts/rotate-wallet-key.ts --verify --key def456...
  `);
}

// ─────────────────────────────────────────────────────────────────────────────
// Rotation Logic
// ─────────────────────────────────────────────────────────────────────────────

async function rotateWalletKeys(
  oldKeyHex: string,
  newKeyHex: string,
  dryRun: boolean = false
): Promise<RotationMetrics> {
  const prisma = new PrismaClient();
  const metrics = initializeMetrics(dryRun);

  try {
    const oldKey = Buffer.from(oldKeyHex, 'hex');
    const newKey = Buffer.from(newKeyHex, 'hex');

    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📦 Custodial Wallet Key Rotation');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');

    console.log('🔍 Counting custodial wallets on v1...');
    metrics.totalWallets = await prisma.custodialWallet.count({ where: { keyVersion: 1 } });

    if (metrics.totalWallets === 0) {
      console.log('✅ No v1 wallets to rotate.');
      return finalizeMetrics(metrics);
    }

    console.log(`📊 Found ${metrics.totalWallets} v1 wallet(s) to rotate.`);
    console.log(`🔐 Mode: ${dryRun ? 'DRY RUN (no changes)' : 'LIVE ROTATION'}`);
    console.log(`📋 Rotation ID: ${metrics.rotationId}`);
    console.log('');

    const logInterval = setInterval(() => {
      const progress = calculateProgress(metrics);
      if (progress.total > 0) {
        logRotationProgress(metrics, progress);
      }
    }, 2000); // Log progress every 2 seconds

    try {
      let cursor: string | undefined;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const batch = await prisma.custodialWallet.findMany({
          where: { keyVersion: 1 },
          take: BATCH_SIZE,
          ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
          orderBy: { id: 'asc' },
        });

        if (batch.length === 0) break;
        cursor = batch[batch.length - 1].id;

        for (const wallet of batch) {
          const startedAt = Date.now();
          try {
            const secret = decryptSecret(wallet.encryptedSecret, wallet.iv, wallet.authTag, oldKey);
            const { encrypted, iv, authTag } = encryptSecret(secret, newKey);

            // Verify the freshly-encrypted blob actually decrypts back to
            // the exact original secret with the new key before writing it.
            const roundTrip = decryptSecret(encrypted, iv, authTag, newKey);
            if (roundTrip !== secret) {
              throw new Error('Round-trip verification mismatch after re-encryption');
            }

            if (!dryRun) {
              await prisma.custodialWallet.update({
                where: { id: wallet.id },
                data: {
                  encryptedSecret: encrypted,
                  iv,
                  authTag,
                  keyVersion: 2,
                  updatedAt: new Date(),
                },
              });
            }

            recordSuccess(metrics, Date.now() - startedAt);
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : 'unknown error';
            recordError(metrics, wallet.id, wallet.userId, errorMsg);
          }
        }
        // Cursor already updated at the start of the loop
      }
    } finally {
      clearInterval(logInterval);
    }

    // Finalize metrics — finalizeMetrics returns a NEW object rather than
    // mutating `metrics` in place, so the return value must be captured.
    const finalized = finalizeMetrics(metrics);

    console.log('');
    console.log(formatMetricsSummary(finalized));

    return finalized;
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Verify mode: attempt to decrypt every wallet using only the given key
 * (no fallback). Reports anything that fails, which means that wallet
 * still needs rotation (or this is simply the wrong key).
 */
async function verifyWalletKeys(keyHex: string): Promise<void> {
  const prisma = new PrismaClient();

  try {
    const key = Buffer.from(keyHex, 'hex');
    const total = await prisma.custodialWallet.count();

    console.log('');
    console.log(`🔎 Verifying ${total} wallet(s) decrypt with the provided key...`);
    console.log('');

    let verified = 0;
    const failed: { id: string; userId: string }[] = [];
    let skip = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const batch = await prisma.custodialWallet.findMany({
        take: BATCH_SIZE,
        skip,
        orderBy: { id: 'asc' },
      });
      if (batch.length === 0) break;

      for (const wallet of batch) {
        try {
          decryptSecret(wallet.encryptedSecret, wallet.iv, wallet.authTag, key);
          verified++;
        } catch {
          failed.push({ id: wallet.id, userId: wallet.userId });
        }
      }

      skip += batch.length;
    }

    console.log(`✅ Verified: ${verified}/${total}`);

    if (failed.length > 0) {
      console.log(`❌ Failed to decrypt with this key: ${failed.length}`);
      console.log('   These wallets still need rotation, or this is the wrong key:');
      failed.slice(0, 10).forEach((f) => console.log(`   - wallet ${f.id} (user ${f.userId.substring(0, 8)}...)`));
      if (failed.length > 10) {
        console.log(`   ... and ${failed.length - 10} more`);
      }
      process.exitCode = 1;
    } else {
      console.log('🎉 All wallets decrypt successfully with this key. Rotation is complete.');
    }
  } finally {
    await prisma.$disconnect();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Entry Point
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  let oldKeyArg: string | undefined;
  let newKeyArg: string | undefined;
  let verifyKeyArg: string | undefined;
  let verifyMode = false;
  let dryRun = false;
  let skipConfirm = false;
  let usedInsecureCliKeyInput = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--old-key' && i + 1 < args.length) {
      oldKeyArg = args[++i];
      usedInsecureCliKeyInput = true;
    } else if (args[i] === '--new-key' && i + 1 < args.length) {
      newKeyArg = args[++i];
      usedInsecureCliKeyInput = true;
    } else if (args[i] === '--key' && i + 1 < args.length) {
      verifyKeyArg = args[++i];
      usedInsecureCliKeyInput = true;
    } else if (args[i] === '--verify') {
      verifyMode = true;
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    } else if (args[i] === '--skip-confirm') {
      skipConfirm = true;
    } else if (args[i] === '--help' || args[i] === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  if (usedInsecureCliKeyInput) {
    console.warn('⚠️  Passing keys via CLI flags can leak them into shell history and process listings (ps aux).');
    console.warn('   Prefer WALLET_ROTATION_OLD_KEY / WALLET_ROTATION_NEW_KEY env vars, or the interactive prompt.');
    console.warn('');
  }

  if (verifyMode) {
    const key =
      verifyKeyArg ||
      process.env.WALLET_ROTATION_NEW_KEY ||
      (await promptHidden('Enter key to verify against (64 hex chars): '));

    if (!validateHexKey(key, 'Key')) {
      process.exit(1);
    }

    await verifyWalletKeys(key);
    return;
  }

  // Prefer env vars, then CLI flags, then an interactive masked prompt
  oldKeyArg = oldKeyArg || process.env.WALLET_ROTATION_OLD_KEY;
  newKeyArg = newKeyArg || process.env.WALLET_ROTATION_NEW_KEY;

  if (!oldKeyArg) {
    oldKeyArg = await promptHidden('Enter current WALLET_ENCRYPTION_KEY (64 hex chars): ');
  }
  if (!newKeyArg) {
    newKeyArg = await promptHidden('Enter new WALLET_ENCRYPTION_KEY (64 hex chars): ');
  }

  // Validate keys
  if (!validateHexKey(oldKeyArg, 'Old key') || !validateHexKey(newKeyArg, 'New key')) {
    process.exit(1);
  }

  if (oldKeyArg === newKeyArg) {
    console.error('❌ Old key and new key must be different.');
    process.exit(1);
  }

  // Confirmation
  console.log('');
  console.log('⚠️  WARNING: This operation will re-encrypt all custodial wallets.');
  console.log('   - Ensure the database is backed up before proceeding');
  console.log('   - Either stop application servers, or set WALLET_ENCRYPTION_KEY_OLD to the');
  console.log('     old key so in-flight reads keep working via dual-key fallback');
  console.log('   - Do NOT interrupt the rotation process');
  console.log('   - Once complete, run --verify, then update WALLET_ENCRYPTION_KEY in your environment');
  console.log('');

  const confirmed =
    skipConfirm || (await promptYesNo('Do you want to continue? (yes/no): '));

  if (!confirmed) {
    console.log('❌ Rotation cancelled.');
    process.exit(0);
  }

  if (dryRun) {
    console.log('ℹ️  DRY RUN MODE: Changes will not be applied to the database.');
  }

  console.log('');

  // Perform rotation
  const metrics = await rotateWalletKeys(oldKeyArg, newKeyArg, dryRun);

  // Save metrics
  const metricsPath = saveMetricsToFile(metrics, METRICS_OUTPUT_DIR);
  console.log(`[metrics] Rotation metrics saved: ${metricsPath}`);

  if (dryRun) {
    const reportPath = saveDryRunReport(metrics, METRICS_OUTPUT_DIR);
    console.log(`[report] Dry-run report saved: ${reportPath}`);
  }

  // Exit with appropriate code
  process.exit(metrics.failedRotations > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});