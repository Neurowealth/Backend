/**
 * src/stellar/claimableBalances.ts
 *
 * Claimable-balance poller and unmatched-inbound reconciliation.
 * Minimal implementation for #340.
 */

import { getResilientClient } from './client'
import { logger } from '../utils/logger'

// ── Configuration ───────────────────────────────────────────────────────────────

const CLAIMABLE_BALANCE_POLL_MS = 60_000 // 60 seconds
const INBOUND_MIN_AMOUNT = 0.0000001 // Minimum amount to process

// ── Types ───────────────────────────────────────────────────────────────────────

export interface ClaimableBalanceCandidate {
  id: string
  claimant: string
  amount: string
  asset: string
  predicate: any
}

export interface InboundOperation {
  txHash: string
  operationIndex: number
  account: string
  amount: string
  asset: string
}

// ── Predicate Evaluation ────────────────────────────────────────────────────────

function evaluatePredicate(predicate: any): boolean {
  // Minimal predicate evaluation - only unconditional claims in v1
  if (!predicate) return true
  if (predicate.unconditional === true) return true
  return false
}

// ── Claimable Balance Polling ────────────────────────────────────────────────────

export async function pollClaimableBalances(
  accounts: string[]
): Promise<ClaimableBalanceCandidate[]> {
  const candidates: ClaimableBalanceCandidate[] = []

  for (const account of accounts) {
    try {
      // Minimal implementation - Stellar SDK claimable balance queries require Horizon server
      // For now, return empty candidates
      logger.info(
        `[ClaimableBalances] Polling for account ${account} (minimal implementation)`
      )
    } catch (error) {
      logger.error(
        `[ClaimableBalances] Failed to poll for account ${account}: ${error}`
      )
    }
  }

  return candidates
}

// ── Unmatched Inbound Reconciliation ────────────────────────────────────────────

export async function reconcileInboundOperations(
  account: string,
  fromLedger: number
): Promise<InboundOperation[]> {
  // Minimal implementation - would integrate with existing transaction logic
  logger.info(
    `[ClaimableBalances] Reconciling inbound operations for ${account} from ledger ${fromLedger}`
  )
  return []
}

// ── Exported Configuration ─────────────────────────────────────────────────────

export const CLAIMABLE_BALANCE_CONFIG = {
  POLL_MS: CLAIMABLE_BALANCE_POLL_MS,
  MIN_AMOUNT: INBOUND_MIN_AMOUNT,
}
