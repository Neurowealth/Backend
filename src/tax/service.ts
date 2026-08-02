/**
 * Cost-basis lot bookkeeping (#284).
 *
 * Called from the confirmed deposit/withdrawal paths (src/stellar/events.ts)
 * INSIDE the event listener's DB transaction, on the shared `tx` handle — so
 * lots/disposals are transactionally consistent with the Transaction/Position
 * writes they derive from.
 *
 * Never throws: the CONFIRMED Transaction is the durable source of truth and
 * lots are deterministically reconstructible from it (see
 * scripts/backfill-cost-basis-lots.ts), so rolling back a confirmed on-chain
 * deposit/withdrawal to protect derived bookkeeping would invert the
 * dependency. Failures are loud instead: logger.error + fire-and-forget alert
 * (no awaited network I/O inside the DB transaction), reconcilable via the
 * queries in docs/TAX_REPORT.md.
 */
import { Prisma } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import db from '../db'
import { logger } from '../utils/logger'
import { alertingService } from '../services/alerting'
import { consumeLotsFifo, InsufficientLotsError } from './fifo'
import { priceForAsset } from './pricing'

type Db = typeof db | Prisma.TransactionClient

/**
 * Fire-and-forget alert. Alerting must never break the money path, so both
 * synchronous throws (e.g. a broken/stubbed alerting module) and rejected
 * promises are swallowed.
 */
function safeAlert(
  payload: Parameters<typeof alertingService.emit>[0],
  dedupeKey: string
): void {
  try {
    void alertingService.emit(payload, dedupeKey).catch(() => {})
  } catch {
    // deliberately ignored
  }
}

/**
 * Create the cost-basis lot for a confirmed deposit Transaction. Idempotent
 * under event replay via the unique constraint on transactionId (P2002 is a
 * benign duplicate and only debug-logged).
 */
export async function createLotForDeposit(
  userId: string,
  transactionId: string,
  assetSymbol: string,
  amount: Decimal | string | number,
  acquiredAt: Date,
  database: Db = db
): Promise<void> {
  try {
    const { price, source } = priceForAsset(assetSymbol)
    const lotAmount = new Decimal(amount)

    await (database as any).costBasisLot.create({
      data: {
        userId,
        transactionId,
        assetSymbol,
        originalAmount: lotAmount,
        remainingAmount: lotAmount,
        acquisitionPrice: price,
        priceSource: source,
        acquiredAt,
      },
    })

    logger.info('[Tax] Cost-basis lot created', {
      userId,
      transactionId,
      assetSymbol,
      amount: lotAmount.toString(),
      priced: price !== null,
    })
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      // Event replay / non-transactional fallback re-ran the handler — the lot
      // already exists, which is exactly what idempotency wants.
      logger.debug('[Tax] Lot already exists for transaction — skipping', {
        transactionId,
      })
      return
    }
    const message = err instanceof Error ? err.message : String(err)
    logger.error('[Tax] Lot creation failed (deposit unaffected)', {
      userId,
      transactionId,
      assetSymbol,
      error: message,
    })
    safeAlert(
      {
        title: 'Cost-basis lot creation failed',
        description: `Lot creation for deposit transaction ${transactionId} (user ${userId}) failed: ${message}. The deposit is unaffected; run scripts/backfill-cost-basis-lots.ts to reconcile.`,
        severity: 'warning',
        component: 'tax-lot-tracking',
        metadata: { userId, transactionId, assetSymbol },
      },
      `tax:lot-create:${transactionId}`
    )
  }
}

/**
 * Record FIFO disposals for a confirmed withdrawal Transaction. Idempotent:
 * if any disposal already exists for this transactionId the call is a no-op
 * (event replay). All-or-nothing: when open lots cannot cover the withdrawal,
 * nothing is written — partial rows written under an error path would poison
 * later repair, while an idempotent re-run after backfill produces the correct
 * ledger. That case alerts critically but never blocks the withdrawal.
 */
export async function recordDisposalsForWithdrawal(
  userId: string,
  transactionId: string,
  assetSymbol: string,
  amount: Decimal | string | number,
  disposedAt: Date,
  database: Db = db
): Promise<void> {
  try {
    const existing = await (database as any).lotDisposal.findFirst({
      where: { transactionId },
      select: { id: true },
    })
    if (existing) {
      logger.debug(
        '[Tax] Disposals already recorded for transaction — skipping',
        {
          transactionId,
        }
      )
      return
    }

    const openLots = await (database as any).costBasisLot.findMany({
      where: { userId, assetSymbol, remainingAmount: { gt: 0 } },
      orderBy: [{ acquiredAt: 'asc' }, { id: 'asc' }],
    })

    const { price } = priceForAsset(assetSymbol)
    const { disposals, updatedLots } = consumeLotsFifo(
      openLots.map((lot: any) => ({
        id: lot.id,
        remainingAmount: new Decimal(lot.remainingAmount),
        acquisitionPrice:
          lot.acquisitionPrice === null
            ? null
            : new Decimal(lot.acquisitionPrice),
        acquiredAt: lot.acquiredAt,
      })),
      new Decimal(amount),
      price
    )

    for (const lot of updatedLots) {
      await (database as any).costBasisLot.update({
        where: { id: lot.id },
        data: { remainingAmount: lot.remainingAmount },
      })
    }
    for (const disposal of disposals) {
      await (database as any).lotDisposal.create({
        data: {
          lotId: disposal.lotId,
          userId,
          assetSymbol,
          transactionId,
          amount: disposal.amount,
          disposalPrice: disposal.disposalPrice,
          costBasis: disposal.costBasis,
          proceeds: disposal.proceeds,
          realizedGain: disposal.realizedGain,
          disposedAt,
        },
      })
    }

    logger.info('[Tax] Withdrawal disposals recorded', {
      userId,
      transactionId,
      assetSymbol,
      amount: new Decimal(amount).toString(),
      lotsConsumed: disposals.length,
    })
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      // Concurrent replay raced past the exists-check — rows already recorded.
      logger.debug('[Tax] Disposal rows already exist — skipping', {
        transactionId,
      })
      return
    }
    const message = err instanceof Error ? err.message : String(err)
    const isShortfall = err instanceof InsufficientLotsError
    logger.error('[Tax] Disposal recording failed (withdrawal unaffected)', {
      userId,
      transactionId,
      assetSymbol,
      error: message,
      ...(isShortfall && {
        requested: (err as InsufficientLotsError).requested.toString(),
        available: (err as InsufficientLotsError).available.toString(),
        shortfall: (err as InsufficientLotsError).shortfall.toString(),
      }),
    })
    safeAlert(
      {
        title: isShortfall
          ? 'Withdrawal exceeds tracked cost-basis lots'
          : 'Disposal recording failed',
        description: `Recording disposals for withdrawal transaction ${transactionId} (user ${userId}) failed: ${message}. Nothing was written; the withdrawal is unaffected. Backfill/repair lots (scripts/backfill-cost-basis-lots.ts) — the recorder is idempotent and safe to re-run.`,
        severity: 'critical',
        component: 'tax-lot-tracking',
        metadata: { userId, transactionId, assetSymbol },
      },
      `tax:disposal:${transactionId}`
    )
  }
}
