/**
 * Wallet Key Rotation Metrics & Logging Utilities
 * 
 * Provides structured logging and metrics collection for key rotation operations.
 * Metrics are saved to JSON file and can be integrated with monitoring systems.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export interface RotationMetrics {
  // Timing
  startTime: Date;
  endTime?: Date;
  durationMs?: number;

  // Counts
  totalWallets: number;
  successfullyRotated: number;
  failedRotations: number;
  skipped: number;

  // Performance
  // totalRotationTimeMs is an internal accumulator (sum of per-wallet
  // decrypt+encrypt+write durations) used to derive avg/min/max below.
  totalRotationTimeMs?: number;
  avgRotationTimeMs?: number;
  minRotationTimeMs?: number;
  maxRotationTimeMs?: number;
  throughputWalletsPerSecond?: number;

  // Errors
  errors: RotationError[];

  // Metadata
  rotationId: string;
  dryRun: boolean;
  timestamp: string;
  environment: string;
  databaseUrl?: string; // Redacted
}

export interface RotationError {
  walletId: string;
  userId: string;
  error: string;
  timestamp: string;
}

export interface RotationProgress {
  current: number;
  total: number;
  percent: number;
  walletsPerSecond: number;
  estimatedSecondsRemaining: number;
}

/**
 * Redact sensitive information from database URL for logging
 */
export function redactDatabaseUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    // Keep only host, port, and database name
    return `${urlObj.protocol}//*:**@${urlObj.host}${urlObj.pathname}`;
  } catch {
    return '***redacted***';
  }
}

/**
 * Create a unique rotation ID for tracking
 */
export function generateRotationId(): string {
  return `rotation-${crypto.randomBytes(8).toString('hex')}-${Date.now()}`;
}

/**
 * Initialize metrics object
 */
export function initializeMetrics(dryRun: boolean = false): RotationMetrics {
  const databaseUrl = process.env.DATABASE_URL;
  
  return {
    startTime: new Date(),
    totalWallets: 0,
    successfullyRotated: 0,
    failedRotations: 0,
    skipped: 0,
    errors: [],
    rotationId: generateRotationId(),
    dryRun,
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    databaseUrl: databaseUrl ? redactDatabaseUrl(databaseUrl) : undefined,
  };
}

/**
 * Calculate progress metrics
 */
export function calculateProgress(
  metrics: RotationMetrics
): RotationProgress {
  if (metrics.totalWallets === 0) {
    return {
      current: 0,
      total: 0,
      percent: 0,
      walletsPerSecond: 0,
      estimatedSecondsRemaining: 0,
    };
  }

  const processed = metrics.successfullyRotated + metrics.failedRotations;
  const elapsedMs = Date.now() - metrics.startTime.getTime();
  const elapsedSeconds = elapsedMs / 1000;

  const walletsPerSecond = elapsedSeconds > 0 ? processed / elapsedSeconds : 0;
  const remainingWallets = metrics.totalWallets - processed;
  const estimatedSecondsRemaining =
    walletsPerSecond > 0 ? remainingWallets / walletsPerSecond : 0;

  return {
    current: processed,
    total: metrics.totalWallets,
    percent: Math.round((processed / metrics.totalWallets) * 100),
    walletsPerSecond: Math.round(walletsPerSecond * 100) / 100,
    estimatedSecondsRemaining: Math.round(estimatedSecondsRemaining),
  };
}

/**
 * Finalize metrics after rotation completes.
 *
 * IMPORTANT: this is a pure function — it returns a NEW metrics object with
 * endTime/durationMs/etc. filled in rather than mutating the object you pass
 * in. Callers must use the return value:
 *
 *   const finalized = finalizeMetrics(metrics);
 *   // use `finalized`, not the original `metrics`, from here on
 */
export function finalizeMetrics(metrics: RotationMetrics): RotationMetrics {
  const endTime = new Date();
  const durationMs = endTime.getTime() - metrics.startTime.getTime();

  const processed = metrics.successfullyRotated + metrics.failedRotations;
  const durationSeconds = durationMs / 1000;

  // Prefer real per-wallet timings (accumulated via recordSuccess's
  // durationMs argument) when available. Fall back to a coarse estimate
  // (wall-clock duration / wallets processed) only if no per-wallet timing
  // was recorded — that estimate includes DB round-trip and progress-log
  // overhead, so it's a rough upper bound, not a precise per-op time.
  const avgRotationTimeMs =
    metrics.totalRotationTimeMs !== undefined && metrics.successfullyRotated > 0
      ? Math.round((metrics.totalRotationTimeMs / metrics.successfullyRotated) * 100) / 100
      : processed > 0
        ? Math.round((durationMs / processed) * 100) / 100
        : undefined;

  return {
    ...metrics,
    endTime,
    durationMs,
    avgRotationTimeMs,
    minRotationTimeMs: metrics.minRotationTimeMs,
    maxRotationTimeMs: metrics.maxRotationTimeMs,
    throughputWalletsPerSecond:
      durationSeconds > 0
        ? Math.round((processed / durationSeconds) * 100) / 100
        : undefined,
  };
}

/**
 * Add an error to the metrics
 */
export function recordError(
  metrics: RotationMetrics,
  walletId: string,
  userId: string,
  error: string
): void {
  metrics.failedRotations += 1;
  metrics.errors.push({
    walletId,
    userId,
    error,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Record a successful rotation.
 * Pass the wall-clock duration (ms) of this wallet's decrypt+encrypt+write
 * so finalizeMetrics can report real avg/min/max instead of an estimate.
 */
export function recordSuccess(metrics: RotationMetrics, durationMs?: number): void {
  metrics.successfullyRotated += 1;

  if (typeof durationMs === 'number') {
    metrics.totalRotationTimeMs = (metrics.totalRotationTimeMs ?? 0) + durationMs;
    metrics.minRotationTimeMs =
      metrics.minRotationTimeMs === undefined ? durationMs : Math.min(metrics.minRotationTimeMs, durationMs);
    metrics.maxRotationTimeMs =
      metrics.maxRotationTimeMs === undefined ? durationMs : Math.max(metrics.maxRotationTimeMs, durationMs);
  }
}

/**
 * Record a skipped wallet
 */
export function recordSkipped(metrics: RotationMetrics): void {
  metrics.skipped += 1;
}

/**
 * Save metrics to a JSON file
 */
export function saveMetricsToFile(
  metrics: RotationMetrics,
  outputDir: string = process.cwd()
): string {
  const filename = `wallet-rotation-${metrics.rotationId}.json`;
  const filepath = path.join(outputDir, filename);

  // Create output directory if it doesn't exist
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Write metrics file
  fs.writeFileSync(filepath, JSON.stringify(metrics, null, 2));

  // Also create a summary file for quick reference
  const summaryFilepath = path.join(outputDir, `wallet-rotation-summary-${metrics.rotationId}.txt`);
  const summary = formatMetricsSummary(metrics);
  fs.writeFileSync(summaryFilepath, summary);

  return filepath;
}

/**
 * Format metrics as human-readable summary
 */
export function formatMetricsSummary(metrics: RotationMetrics): string {
  const durationSec = metrics.durationMs ? (metrics.durationMs / 1000).toFixed(2) : 'N/A';
  const successRate =
    metrics.totalWallets > 0
      ? Math.round((metrics.successfullyRotated / metrics.totalWallets) * 10000) / 100
      : 0;

  return `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📦 Custodial Wallet Key Rotation - Summary Report
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📊 Rotation Metrics:
  Rotation ID:           ${metrics.rotationId}
  Mode:                  ${metrics.dryRun ? 'DRY RUN' : 'LIVE'}
  Timestamp:             ${metrics.timestamp}
  Environment:           ${metrics.environment}

📈 Results:
  Total wallets:         ${metrics.totalWallets}
  Successfully rotated:  ${metrics.successfullyRotated} (${successRate}%)
  Failed:                ${metrics.failedRotations}
  Skipped:               ${metrics.skipped}

⏱️  Performance:
  Duration:              ${durationSec}s
  Throughput:            ${metrics.throughputWalletsPerSecond ?? 'N/A'} wallets/sec
  Avg time per wallet:   ${metrics.avgRotationTimeMs !== undefined ? metrics.avgRotationTimeMs + 'ms' : 'N/A'}
  Min time per wallet:   ${metrics.minRotationTimeMs !== undefined ? metrics.minRotationTimeMs + 'ms' : 'N/A'}
  Max time per wallet:   ${metrics.maxRotationTimeMs !== undefined ? metrics.maxRotationTimeMs + 'ms' : 'N/A'}

${metrics.errors.length > 0 ? `⚠️  Errors (${metrics.errors.length}):` : ''}
${metrics.errors
  .slice(0, 10)
  .map((err) => `  - ${err.userId.substring(0, 8)}... (${err.walletId.substring(0, 8)}...): ${err.error}`)
  .join('\n')}
${metrics.errors.length > 10 ? `  ... and ${metrics.errors.length - 10} more\n` : ''}

Status: ${metrics.failedRotations === 0 ? '✅ SUCCESS' : '❌ FAILED'}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;
}

/**
 * Export metrics in Prometheus format for integration
 */
export function formatMetricsPrometheus(metrics: RotationMetrics): string {
  const lines: string[] = [
    '# HELP wallet_rotation_total Total wallets processed during rotation',
    '# TYPE wallet_rotation_total gauge',
    `wallet_rotation_total{rotation_id="${metrics.rotationId}",status="success"} ${metrics.successfullyRotated}`,
    `wallet_rotation_total{rotation_id="${metrics.rotationId}",status="failed"} ${metrics.failedRotations}`,
    `wallet_rotation_total{rotation_id="${metrics.rotationId}",status="skipped"} ${metrics.skipped}`,
    '',
    '# HELP wallet_rotation_duration_seconds Duration of wallet rotation in seconds',
    '# TYPE wallet_rotation_duration_seconds gauge',
    `wallet_rotation_duration_seconds{rotation_id="${metrics.rotationId}"} ${(metrics.durationMs || 0) / 1000}`,
    '',
    '# HELP wallet_rotation_throughput_walletsps Throughput of wallet rotation in wallets per second',
    '# TYPE wallet_rotation_throughput_walletsps gauge',
    `wallet_rotation_throughput_walletsps{rotation_id="${metrics.rotationId}"} ${metrics.throughputWalletsPerSecond || 0}`,
  ];

  return lines.join('\n');
}

/**
 * Generate a dedicated dry-run report string.
 * Safe to store in CI artifacts, logs, or audit records — no secrets, keys, or credentials.
 */
export function generateDryRunReport(metrics: RotationMetrics): string {
  const durationSec = metrics.durationMs !== undefined ? (metrics.durationMs / 1000).toFixed(2) : 'N/A';
  const isReady = metrics.failedRotations === 0;
  const readiness = isReady ? 'READY' : 'NOT READY';
  const dbDisplay = metrics.databaseUrl ?? 'not available';

  const sep = '=================================================================';
  const lines: string[] = [];

  lines.push(sep);
  lines.push('WALLET ROTATION DRY-RUN REPORT');
  lines.push(sep);
  lines.push(`Report ID:        ${metrics.rotationId}`);
  lines.push(`Generated At:     ${metrics.timestamp}`);
  lines.push(`Environment:      ${metrics.environment}`);
  lines.push(`Mode:             DRY RUN (no changes made)`);
  lines.push(`Database:         ${dbDisplay}`);
  lines.push(sep);
  lines.push('');
  lines.push('SUMMARY');
  lines.push('-------');
  lines.push(`Total Wallets Scanned:  ${metrics.totalWallets}`);
  lines.push(`Successfully Validated: ${metrics.successfullyRotated}`);
  lines.push(`Validation Failures:    ${metrics.failedRotations}`);
  lines.push(`Rotation Readiness:     ${readiness}`);
  lines.push('');
  lines.push(sep);
  lines.push('VALIDATION RESULTS');
  lines.push(sep);

  if (metrics.failedRotations === 0) {
    lines.push(`All ${metrics.totalWallets} wallets passed validation checks:`);
    lines.push('  - Decryption successful with current key');
    lines.push('  - Re-encryption round-trip verified');
    lines.push('  - No wallet would fail after rotation');
  } else {
    lines.push(`WARNING: ${metrics.failedRotations} wallet(s) failed validation:`);
    const displayErrors = metrics.errors.slice(0, 20);
    for (const err of displayErrors) {
      lines.push(
        `  [FAIL] Wallet ${err.walletId.substring(0, 8)}... (User ${err.userId.substring(0, 8)}...): ${err.error}`
      );
    }
    if (metrics.errors.length > 20) {
      lines.push(`  ... and ${metrics.errors.length - 20} more`);
    }
  }

  lines.push('');
  lines.push(sep);
  lines.push('WARNINGS');
  lines.push(sep);

  if (metrics.failedRotations === 0) {
    lines.push('None.');
  } else {
    lines.push(`- ${metrics.failedRotations} wallet(s) cannot be decrypted with the provided old key.`);
    lines.push('- These wallets must be investigated before proceeding with live rotation.');
    lines.push('- The live rotation will abort if any wallet fails decryption.');
  }

  lines.push('');
  lines.push(sep);
  lines.push('NEXT STEPS');
  lines.push(sep);

  if (isReady) {
    lines.push('1. The dry-run completed successfully. All wallets are ready for rotation.');
    lines.push('2. Schedule a maintenance window for the live rotation.');
    lines.push('3. Back up the database before running live rotation.');
    lines.push('4. Run live rotation:');
    lines.push('     WALLET_ROTATION_OLD_KEY=<current-key> WALLET_ROTATION_NEW_KEY=<new-key> \\');
    lines.push('       npx ts-node scripts/rotate-wallet-key.ts --skip-confirm');
    lines.push('5. After rotation, verify all wallets decrypted with the new key:');
    lines.push('     npx ts-node scripts/rotate-wallet-key.ts --verify --key <new-key>');
    lines.push('6. Update WALLET_ENCRYPTION_KEY in your environment/secrets manager.');
  } else {
    lines.push(`1. Investigate the ${metrics.failedRotations} wallet(s) that failed validation (listed above).`);
    lines.push('2. Ensure the correct OLD key is being used for the dry-run.');
    lines.push('3. Re-run the dry-run after resolving failures before attempting live rotation.');
  }

  lines.push('');
  lines.push(sep);
  lines.push('PERFORMANCE ESTIMATE');
  lines.push(sep);
  lines.push(`Wallets Scanned:  ${metrics.totalWallets}`);
  lines.push(`Duration:         ${durationSec}s`);
  lines.push(`Est. Live Duration: ~${durationSec}s (includes DB writes)`);
  lines.push('');
  lines.push(sep);
  lines.push('SAFETY NOTES');
  lines.push(sep);
  lines.push('- This report contains NO private keys, secrets, or credentials.');
  lines.push('- Wallet IDs are truncated to first 8 characters for security.');
  lines.push('- User IDs are truncated to first 8 characters for security.');
  lines.push('- Safe to store in CI artifacts, logs, or audit records.');
  lines.push(sep);

  return lines.join('\n');
}

/**
 * Save dry-run report to a .txt file in outputDir.
 * Returns the absolute path to the written file.
 */
export function saveDryRunReport(metrics: RotationMetrics, outputDir: string): string {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const filename = `wallet-rotation-dry-run-${metrics.rotationId}.txt`;
  const filepath = path.join(outputDir, filename);
  const report = generateDryRunReport(metrics);
  fs.writeFileSync(filepath, report);

  return filepath;
}

/**
 * Log rotation progress to console with formatting
 */
export function logRotationProgress(
  metrics: RotationMetrics,
  progress: RotationProgress,
  currentUserId?: string
): void {
  if (progress.total === 0) return;

  const progressBar = createProgressBar(progress.percent, 50);
  const eta = formatTimeRemaining(progress.estimatedSecondsRemaining);

  console.log(
    `${progressBar} ${progress.percent}% (${progress.current}/${progress.total}) ` +
      `${progress.walletsPerSecond} wallets/sec ETA: ${eta}`
  );
}

/**
 * Create a simple text-based progress bar
 */
function createProgressBar(percent: number, width: number = 50): string {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  return `[${'\u2588'.repeat(filled)}${'\u2591'.repeat(empty)}]`;
}

/**
 * Format seconds into human-readable time
 */
function formatTimeRemaining(seconds: number): string {
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    const secs = Math.round(seconds % 60);
    return `${minutes}m ${secs}s`;
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}