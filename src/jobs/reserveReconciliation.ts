/**
 * Reserve reconciliation job (#339) — walks ReserveSponsorship against on-chain
 * sponsor fields and flags drift, joining against pending outbox ops before
 * alerting.
 */

import db from '../db'
import { logger } from '../utils/logger'
import { getAccount } from '../stellar/client'
import {
  reserveOutstandingXlm,
  sponsorAvailableXlmGauge,
  reserveReconciliationDrift,
  sponsorCapacityExhaustedTotal,
} from '../utils/metrics'
import { alertingService } from '../services/alerting'
import { config } from '../config/env'

export async function reconcileOnce(): Promise<{
  driftCount: number
  outstandingXlm: number
}> {
  const active = await (db as any).reserveSponsorship.findMany({
    where: { status: 'ACTIVE' },
  })

  let outstanding = 0
  for (const r of active) {
    outstanding += Number(r.xlmReserved)
  }
  reserveOutstandingXlm.set(outstanding)

  // per-sponsor balances
  try {
    const sponsorKeys = (process.env.STELLAR_SPONSOR_KEYS || process.env.STELLAR_SPONSOR_SECRET_KEY || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (sponsorKeys.length === 0 && process.env.STELLAR_AGENT_SECRET_KEY) {
      sponsorKeys.push(process.env.STELLAR_AGENT_SECRET_KEY)
    }
    for (const secret of sponsorKeys) {
      try {
        const { Keypair } = await import('@stellar/stellar-sdk')
        const kp = Keypair.fromSecret(secret)
        const acct: any = await getAccount(kp.publicKey()).catch(() => null)
        if (acct && acct.balances) {
          const native = acct.balances.find((b: any) => b.asset_type === 'native')
          const bal = native ? parseFloat(native.balance) : 0
          const liabilities = native?.selling_liabilities ? parseFloat(native.selling_liabilities) : 0
          const avail = bal - liabilities
          sponsorAvailableXlmGauge.set({ sponsorAccount: kp.publicKey() }, avail)
          // low sponsor alert handled elsewhere; set metric only
        }
      } catch {}
    }
  } catch {}

  // check pending outbox ops to avoid false drift
  const pendingOps = await (db as any).outboxOp.findMany({
    where: { kind: 'ACCOUNT_PROVISION', status: { in: ['PENDING', 'SUBMITTED'] } },
    select: { payload: true },
  })
  const pendingSponsoredIds = new Set(
    pendingOps.map((op: any) => (op.payload as any)?.sponsoredId).filter(Boolean)
  )

  let driftCount = 0
  let driftXlm = 0

  for (const row of active) {
    // skip if pending provision for this sponsoredId
    if (pendingSponsoredIds.has(row.sponsoredId)) continue

    try {
      const wallet = await (db as any).custodialWallet.findUnique({
        where: { id: row.sponsoredId },
        select: { publicKey: true },
      })
      if (!wallet) {
        driftCount++
        driftXlm += Number(row.xlmReserved)
        continue
      }

      const acct: any = await getAccount(wallet.publicKey).catch(() => null)
      if (!acct) {
        // entry gone but we think active -> drift
        driftCount++
        driftXlm += Number(row.xlmReserved)
        logger.warn('[ReserveReconciliation] Active sponsorship but account missing on-chain', {
          sponsoredId: row.sponsoredId,
          publicKey: wallet.publicKey,
          ledgerKey: row.ledgerKey,
        })
        continue
      }

      // Check sponsor field if present (Horizon account may have sponsor)
      const onChainSponsor = acct.sponsor || acct.account?.sponsor || null
      if (onChainSponsor && onChainSponsor !== row.sponsorAccount) {
        driftCount++
        logger.warn('[ReserveReconciliation] Sponsored-by-someone-else', {
          sponsoredId: row.sponsoredId,
          expected: row.sponsorAccount,
          actual: onChainSponsor,
        })
      }

      // Base reserve drift check (protocol current reserve 1 XLM for account, 0.5 for trustline)
      const expected = row.entryType === 'TRUSTLINE' ? 0.5 : 1
      const diff = Math.abs(Number(row.xlmReserved) - expected)
      if (diff > 0.01) {
        driftCount++
        driftXlm += diff
      }
    } catch (err) {
      logger.warn('[ReserveReconciliation] Check failed', {
        sponsoredId: row.sponsoredId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  reserveReconciliationDrift.set(driftXlm)

  if (driftCount > 0) {
    logger.warn('[ReserveReconciliation] Drift detected', { driftCount, driftXlm })
    await alertingService
      .emit(
        {
          title: 'Reserve sponsorship drift detected',
          description: `${driftCount} sponsorship rows drift from on-chain state (drift ${driftXlm} XLM)`,
          severity: 'warning',
          component: 'reserve-reconciliation',
          metadata: { driftCount, driftXlm },
        },
        'reserve:drift'
      )
      .catch(() => {})
  } else {
    logger.info('[ReserveReconciliation] No drift', { outstandingXlm: outstanding })
  }

  return { driftCount, outstandingXlm: outstanding }
}

export async function runReserveReconciliation(): Promise<void> {
  try {
    await reconcileOnce()
  } catch (err) {
    logger.error('[ReserveReconciliation] Failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

let handle: NodeJS.Timeout | null = null

export function scheduleReserveReconciliation(): NodeJS.Timeout {
  void runReserveReconciliation()
  const interval = (config as any).reserveReconciliation?.intervalMs ?? 3600000
  handle = setInterval(() => {
    void runReserveReconciliation()
  }, interval)
  if (handle.unref) handle.unref()
  logger.info('[ReserveReconciliation] Scheduled', { intervalMs: interval })
  return handle
}

export function stopReserveReconciliation(): void {
  if (handle) {
    clearInterval(handle)
    handle = null
  }
}
