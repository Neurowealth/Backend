#!/usr/bin/env ts-node
/**
 * Backfill cost-basis lots & disposals (#284)
 *
 * Replays every CONFIRMED DEPOSIT/WITHDRAWAL Transaction, per user, in
 * confirmedAt order through the same service functions the event listener
 * uses. Both functions are idempotent (transactionId unique / exists-check),
 * so this script is safe to re-run at any time.
 *
 * Run once at deploy of the tax-lot-tracking migration: without it, every
 * pre-existing user's first withdrawal would fire a false-positive
 * "insufficient lots" critical alert. Also the documented repair tool after
 * any lot-creation failure alert. See docs/TAX_REPORT.md.
 *
 * Usage:
 *   npx ts-node scripts/backfill-cost-basis-lots.ts [--dry-run]
 *
 * Environment:
 *   - Database connection required via DATABASE_URL (full env not needed;
 *     imports db + tax service only, not the server config)
 */

import db from '../src/db'
import { logger } from '../src/utils/logger'
import {
  createLotForDeposit,
  recordDisposalsForWithdrawal,
} from '../src/tax/service'

const DRY_RUN = process.argv.includes('--dry-run')

async function main(): Promise<void> {
  const transactions = await db.transaction.findMany({
    where: {
      status: 'CONFIRMED',
      type: { in: ['DEPOSIT', 'WITHDRAWAL'] },
    },
    orderBy: [{ confirmedAt: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      userId: true,
      type: true,
      assetSymbol: true,
      amount: true,
      confirmedAt: true,
      createdAt: true,
      selectedLotIds: true,
    },
  })

  // #317 — each transaction records disposals under its owner's CURRENT
  // accounting method (methods are forward-only; there is no historical
  // per-transaction method to recover). Loaded once per distinct user
  // rather than per transaction.
  const userIds = [...new Set(transactions.map((t) => t.userId))]
  const users = await db.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, accountingMethod: true },
  })
  const methodByUserId = new Map(users.map((u) => [u.id, u.accountingMethod]))

  logger.info('[Tax Backfill] Starting', {
    transactions: transactions.length,
    dryRun: DRY_RUN,
  })

  if (DRY_RUN) {
    const deposits = transactions.filter((t) => t.type === 'DEPOSIT').length
    logger.info('[Tax Backfill] Dry run — no writes', {
      deposits,
      withdrawals: transactions.length - deposits,
    })
    return
  }

  let processed = 0
  for (const tx of transactions) {
    const effectiveAt = tx.confirmedAt ?? tx.createdAt
    if (tx.type === 'DEPOSIT') {
      await createLotForDeposit(
        tx.userId,
        tx.id,
        tx.assetSymbol,
        tx.amount,
        effectiveAt
      )
    } else {
      await recordDisposalsForWithdrawal(
        tx.userId,
        tx.id,
        tx.assetSymbol,
        tx.amount,
        effectiveAt,
        db,
        methodByUserId.get(tx.userId),
        tx.selectedLotIds
      )
    }
    processed++
    if (processed % 500 === 0) {
      logger.info('[Tax Backfill] Progress', {
        processed,
        total: transactions.length,
      })
    }
  }

  logger.info('[Tax Backfill] Complete', { processed })
}

main()
  .catch((err) => {
    logger.error('[Tax Backfill] Failed', {
      error: err instanceof Error ? err.message : String(err),
    })
    process.exitCode = 1
  })
  .finally(() => db.$disconnect())
