/**
 * Protective collateral sale (#532) — the one money movement in the lending
 * book that no user asked for.
 *
 * ─── WHY THERE IS NO STELLAR TRANSACTION HERE ─────────────────────────────────
 * The collateral backing a loan already sits inside the platform's own vault,
 * in a vault tier the protocol controls. A liquidation therefore moves no
 * funds between wallets: it retires debt against collateral the platform
 * already holds, and books the remainder as bad debt. There is nothing to sign
 * on-chain, and pretending otherwise would mean either fabricating a hash or
 * opening the vault to a payout the operation does not need.
 *
 * So the operation is a NETTING ENTRY, and it still goes through the outbox.
 * That is the important part. A forced sale is the single action in this
 * product a user never authorised, moves real value, and can take their
 * position away — so it gets exactly the same guarantees as every other
 * money movement: durable before it happens, priority-ordered ahead of agent
 * rebalances, retried on failure, visible in the queue, and reconciled
 * against an idempotency key. The one thing it skips is a Stellar hash.
 *
 * The returned identifier is a namespaced platform reference
 * (`platform:liquidation:<loanId>:<sequence>`), deliberately not 64 hex
 * characters, so nothing downstream can mistake it for a Stellar hash and
 * treat it as an on-chain fact.
 *
 * ─── ATOMICITY ────────────────────────────────────────────────────────────────
 * The whole sale — collateral derecognised, debt retired, position closed,
 * bad debt recorded, event written — happens in ONE transaction together with
 * the exactly-once claim on the outbox op. A partial liquidation that left a
 * half-sold position would be worse than no liquidation at all.
 */

import type { TransactionResult } from '../stellar/types'
import { db } from '../db'
import { config } from '../config/env'
import { logger } from '../utils/logger'
import { dispatchWebhookEvent } from '../services/webhookDispatcher'
import { publishUserEvent } from '../events/publisher'
import { alertingService } from '../services/alerting'
import { accrueInterest } from './accrual'
import { currentLtv, isLiquidationTriggered, planLiquidation } from './risk'

/** Stable, non-Stellar reference for a netting operation. */
export function liquidationReference(loanId: string, sequence: number): string {
  return `platform:liquidation:${loanId}:${sequence}`
}

function isPlatformReference(hash: string): boolean {
  return hash.startsWith('platform:')
}

/**
 * Execute a planned protective sale. Called from src/outbox/executors.ts —
 * the single submission site for every money movement in the platform — and
 * directly from the test suite.
 *
 * `force` skips the threshold re-check so an operator or a court order can
 * settle the loan immediately at current market value; the ordinary path
 * always re-verifies health at execution time rather than trusting the
 * monitor's decision from minutes ago. Forcing sells only what retires the
 * debt, never the whole position.
 */
export async function applyLoanLiquidationSale(
  payload: {
    userId: string
    loanId: string
    positionId: string
    collateralAmount: number
    collateralAssetSymbol: string
    debtOutstanding: number
    borrowedAsset: string
    trigger: 'scheduled' | 'circuit_breaker'
    transactionId: string
    sequence: number
  },
  options: { force?: boolean } = {}
): Promise<TransactionResult> {
  const now = new Date()

  const outcome = await db.$transaction(async (tx) => {
    const loan = (await tx.collateralLoan.findUnique({
      where: { id: payload.loanId },
      include: { position: true },
    })) as {
      id: string
      userId: string
      positionId: string
      status: string
      borrowedAsset: string
      principalAmount: unknown
      interestAccrued: unknown
      interestAccruedTo: Date
      interestRateApy: unknown
      liquidationLtvThreshold: unknown
      position: {
        id: string
        status: string
        assetSymbol: string
        depositedAmount: unknown
        currentValue: unknown
        yieldEarned: unknown
      }
    } | null

    // Already handled: the op was replayed, or a concurrent sweep got here
    // first. Report success — the end state the caller wanted is true.
    if (!loan || loan.status !== 'ACTIVE') {
      return {
        outcome: 'NOOP' as const,
        reference: liquidationReference(payload.loanId, payload.sequence),
      }
    }

    // Level interest with the clock before valuing, so the decision is made
    // against the real balance at the moment of sale. The re-read carries the
    // same relation set: `accrueInterest` advances the watermark, so the row
    // we hold is already stale and every figure below has to come from the
    // fresh copy — including the collateral, which is read again inside the
    // same transaction so a concurrent mark cannot slip between the two.
    await accrueInterest(loan.id, now, tx)
    const fresh = (await tx.collateralLoan.findUnique({
      where: { id: loan.id },
      include: { position: true },
    })) as typeof loan

    const principal = Number(fresh.principalAmount)
    const interestAccrued = Number(fresh.interestAccrued)
    const rate = Number(fresh.interestRateApy)
    const threshold = Number(fresh.liquidationLtvThreshold)

    const debt = principal + interestAccrued
    const collateralValue = Number(fresh.position.currentValue)
    const ltv = currentLtv({ debt, collateralValue })

    if (!options.force && !isLiquidationTriggered(ltv, threshold)) {
      return {
        outcome: 'HEALED' as const,
        reference: liquidationReference(payload.loanId, payload.sequence),
        ltv,
        threshold,
      }
    }

    const plan = planLiquidation({
      debt,
      collateralValue,
      // A forced sale is a demand to SETTLE THE LOAN NOW at current market
      // value, not a demand to take the collateral — so the target becomes 0
      // and exactly enough is sold to retire the debt, leaving the borrower
      // the rest of their position. Leaving the ordinary target in place would
      // make `force` a no-op on a healthy loan (a healthy position is already
      // under target, so the minimum sale is zero), which is precisely the
      // situation an operator forcing a sale is trying to act on.
      targetLtv: options.force ? 0 : config.lending.liquidationTargetLtv,
      maxCollateralFractionSold: config.lending.maxCollateralFractionSold,
    })

    if (plan.collateralToSell <= 0 && plan.shortfall <= 0) {
      return {
        outcome: 'HEALED' as const,
        reference: liquidationReference(payload.loanId, payload.sequence),
        ltv,
        threshold,
      }
    }

    // ── Derecognise the collateral actually sold ─────────────────────────────
    // Pro-rata on deposited amount, so a partial sale leaves the position
    // holding a proportionally smaller claim rather than an arbitrary slice.
    const deposited = Number(fresh.position.depositedAmount)
    const soldFraction =
      deposited > 0 ? Math.min(1, plan.collateralToSell / collateralValue) : 1
    const depositedSold =
      deposited * (Number.isFinite(soldFraction) ? soldFraction : 1)
    const yieldForfeited =
      deposited > 0
        ? Number(fresh.position.yieldEarned) *
          (Number.isFinite(soldFraction) ? soldFraction : 1)
        : 0

    if (plan.collateralToSell >= collateralValue) {
      await tx.position.update({
        where: { id: fresh.position.id },
        data: { status: 'CLOSED', currentValue: 0, closedAt: now },
      })
    } else {
      await tx.position.update({
        where: { id: fresh.position.id },
        data: {
          depositedAmount: Math.max(0, deposited - depositedSold),
          currentValue: Math.max(0, collateralValue - plan.collateralToSell),
          // The yield on collateral the borrower no longer owns leaves with
          // it. Leaving it behind would let a liquidated position bank yield it
          // never earned.
          yieldEarned: Math.max(
            0,
            Number(fresh.position.yieldEarned) - yieldForfeited
          ),
        },
      })
    }

    // ── Retire the debt and close the loan ───────────────────────────────────
    // Whatever the sale did not cover is carried as new PRINCIPAL with the
    // interest line zeroed. That is a pricing simplification and is deliberate:
    // the alternatives are amortisation schedules with partial repayments,
    // which is a different product. The borrower is not overcharged for the
    // recovered amount — only the ~8% of margin earned on the balance that
    // actually stayed outstanding is folded forward.
    const remainingPrincipal = Math.max(0, debt - plan.debtRetired)
    const closed = remainingPrincipal <= 1e-9 || plan.kind === 'FULL'

    await tx.collateralLoan.update({
      where: { id: fresh.id },
      data: {
        principalAmount: closed ? 0 : remainingPrincipal,
        interestAccrued: 0,
        status: closed ? 'LIQUIDATED' : 'ACTIVE',
        ...(closed ? { closedAt: now } : {}),
        lastValuedAt: now,
        lastValuedCollateral: Math.max(
          0,
          collateralValue - plan.collateralToSell
        ),
        liquidationOutboxOpId: payload.transactionId,
      },
    })

    // ── Record the sale: durable, immutable, and permanently linked ──────────
    const event = await tx.loanLiquidationEvent.create({
      data: {
        loanId: fresh.id,
        userId: fresh.userId,
        trigger: payload.trigger,
        kind: plan.kind,
        ltvBefore: Number.isFinite(plan.ltvBefore) ? plan.ltvBefore : 0,
        ltvAfter: plan.ltvAfter ?? 0,
        collateralSold: plan.collateralToSell,
        debtRetired: plan.debtRetired,
        shortfall: plan.shortfall,
        outboxOpId: payload.transactionId,
      },
    })

    // ── Book the platform's loss ──────────────────────────────────────────────
    if (plan.shortfall > 0) {
      await tx.platformBadDebt.create({
        data: {
          loanId: fresh.id,
          userId: fresh.userId,
          assetSymbol: fresh.borrowedAsset,
          amount: plan.shortfall,
          status: 'OPEN',
          reason: `Liquidation at LTV ${plan.ltvBefore.toFixed(4)} exceeded the ${threshold} threshold; collateral recovered ${plan.debtRetired.toFixed(2)} of ${debt.toFixed(2)}`,
        },
      })
    }

    // Mirror the netting entry onto the ledger Transaction so the user's
    // statement shows the collateral movement as a first-class transaction.
    await tx.transaction.update({
      where: { id: payload.transactionId },
      data: {
        amount: plan.collateralToSell,
        status: 'CONFIRMED',
        txHash: liquidationReference(fresh.id, payload.sequence),
        confirmedAt: now,
        memo: `Collateral liquidation ${plan.kind} (loan:${fresh.id})`,
      },
    })

    return {
      outcome: 'LIQUIDATED' as const,
      reference: liquidationReference(fresh.id, payload.sequence),
      eventId: event.id,
      plan,
      ltvBefore: plan.ltvBefore,
      ltvAfter: plan.ltvAfter,
      closed,
      shortfall: plan.shortfall,
      borrowedAsset: fresh.borrowedAsset,
      userId: fresh.userId,
    }
  })

  if (outcome.outcome === 'NOOP' || outcome.outcome === 'HEALED') {
    logger.info('[Lending] Liquidation op found nothing to do', {
      loanId: payload.loanId,
      outcome: outcome.outcome,
      ltv: outcome.outcome === 'HEALED' ? outcome.ltv : undefined,
    })
    return { hash: outcome.reference, status: 'success' }
  }

  // ── Notify, outside the transaction ────────────────────────────────────────
  // A liquidation takes a user's position without their consent, so it is
  // never a silent ledger change: the user is told on their stream, their
  // webhook fires, and a loud alert is raised. A failure to notify is logged
  // loudly and never rolls back a completed, correct sale.
  const summary = {
    loanId: payload.loanId,
    kind: outcome.plan.kind,
    trigger: payload.trigger,
    collateralSold: outcome.plan.collateralToSell,
    debtRetired: outcome.plan.debtRetired,
    shortfall: outcome.shortfall,
    ltvBefore: outcome.ltvBefore,
    ltvAfter: outcome.ltvAfter,
    reference: outcome.reference,
  }

  try {
    await publishUserEvent(
      outcome.userId,
      'transactions',
      'loan.liquidation_executed',
      summary
    )
    dispatchWebhookEvent('loan.liquidation_executed', {
      userId: outcome.userId,
      ...summary,
    }).catch(() => {})

    if (outcome.shortfall > 0) {
      dispatchWebhookEvent('loan.charged_off', {
        userId: outcome.userId,
        loanId: payload.loanId,
        amount: outcome.shortfall,
        assetSymbol: outcome.borrowedAsset,
      }).catch(() => {})

      // Bad debt is the platform losing real money. That is an operator
      // incident, not just a user notification, so it goes out on the alerting
      // channel with a per-loan cooldown key — one loan cannot spam Slack, but
      // a second bad loan the same hour still gets through.
      await alertingService.emit(
        {
          title: 'Collateral loan charged off',
          description: `Loan ${payload.loanId} (user ${outcome.userId}) was liquidated with a ${outcome.shortfall.toFixed(2)} ${outcome.borrowedAsset} shortfall the collateral could not cover. Trigger: ${payload.trigger}.`,
          severity: 'critical',
          component: 'lending',
          metadata: summary,
        },
        `lending:charge_off:${payload.loanId}`
      )
    } else {
      await alertingService.emit(
        {
          title: 'Collateral liquidated',
          description: `Loan ${payload.loanId} (user ${outcome.userId}) breached its ${outcome.ltvBefore.toFixed(2)} LTV threshold. ${outcome.plan.collateralToSell.toFixed(2)} of collateral sold to retire ${outcome.plan.debtRetired.toFixed(2)} ${outcome.borrowedAsset}.`,
          severity: 'warning',
          component: 'lending',
          metadata: summary,
        },
        `lending:liquidation:${payload.loanId}:${payload.sequence}`
      )
    }
  } catch (err) {
    logger.error('[Lending] Liquidation notifications failed', {
      loanId: payload.loanId,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  logger.warn('[Lending] Collateral liquidated', summary)

  return { hash: outcome.reference, status: 'success' }
}

/**
 * Re-exported so the outbox executor's type contract is checkable in one
 * place: a netting operation must never be mistaken for an on-chain one.
 */
export { isPlatformReference }
