/**
 * Shared withdrawal path for the Telegram and WhatsApp bots (#837).
 *
 * Bot withdrawals must never mutate a fake in-memory balance or report success
 * without a real, persisted transaction. Money movement goes through the same
 * `executeWithdraw` service the REST route uses: it writes a Transaction row
 * and a durable OutboxOp in one DB transaction before dispatching on-chain.
 *
 * Identity is deliberately conservative. Only a WhatsApp sender whose phone
 * number is attached to a real DB User can be resolved; Telegram link codes are
 * ephemeral in-memory state and do not identify a DB account, so Telegram
 * withdrawals fail closed with an explicit "unavailable" reply.
 */

import db from './db'
import { executeWithdraw } from './controllers/transaction-controller'
import { logger } from './utils/logger'

export type BotWithdrawalChannel = 'telegram' | 'whatsapp'

export type BotWithdrawalResult = {
  /** True only when the withdrawal has an on-chain transaction reference. */
  ok: boolean
  body: string
  /** Confirmation hash (or the persisted transaction id while still pending). */
  reference: string | null
}

const UNAVAILABLE_BODY =
  'Withdrawals are temporarily unavailable. No funds have been moved. Please try again later or use the app.'

function unavailable(reason: string, error?: unknown): BotWithdrawalResult {
  logger.warn('[BotWithdrawal] Refusing to report success', {
    reason,
    error:
      error instanceof Error ? error.message : error ? String(error) : null,
  })
  return { ok: false, body: UNAVAILABLE_BODY, reference: null }
}

/**
 * Resolve the authenticated DB user behind a bot identity, if any.
 * WhatsApp numbers are a unique, persisted User field; Telegram has no
 * persisted link to a DB account and is therefore never treated as verified.
 */
async function resolveWithdrawalUser(
  channel: BotWithdrawalChannel,
  identity: string
): Promise<{ id: string; walletAddress: string } | null> {
  if (channel !== 'whatsapp') return null

  const user = await db.user.findUnique({
    where: { phone: identity },
    select: { id: true, walletAddress: true },
  })
  return user?.walletAddress ? user : null
}

/**
 * Execute a confirmed bot withdrawal. The caller must have already obtained
 * the user's explicit confirmation; this function is the only place that
 * starts a real withdrawal for either bot.
 */
export async function executeBotWithdrawal(params: {
  channel: BotWithdrawalChannel
  identity: string
  amount: number
  /** "withdraw all" relies on the fake in-memory balance and is not allowed. */
  all?: boolean
}): Promise<BotWithdrawalResult> {
  const { channel, identity, amount, all } = params

  if (all) {
    return {
      ok: false,
      body: 'Withdrawing all is not available from chat. Please specify an amount, or use the app.',
      reference: null,
    }
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return {
      ok: false,
      body: 'Please specify a withdrawal amount, e.g. "withdraw 5".',
      reference: null,
    }
  }

  try {
    const user = await resolveWithdrawalUser(channel, identity)
    if (!user) {
      return unavailable('no persisted bot identity for a DB account')
    }

    const result = await executeWithdraw({
      userId: user.id,
      walletAddress: user.walletAddress,
      amount,
      assetSymbol: 'XLM',
      memo: `${channel} bot withdrawal`,
    })

    if (result.status === 'CONFIRMED' && result.transaction?.txHash) {
      return {
        ok: true,
        body: `Withdrawal submitted for ${amount.toFixed(2)} XLM.\nTransaction reference: ${result.transaction.txHash}`,
        reference: result.transaction.txHash,
      }
    }

    // A PENDING op is durable, but no funds have moved yet: report the
    // persisted reference without calling it a completed withdrawal.
    if (result.status === 'PENDING' && result.transaction) {
      return {
        ok: false,
        body: `Withdrawal queued for ${amount.toFixed(2)} XLM under reference ${result.transaction.id}. It is not confirmed yet.`,
        reference: result.transaction.id,
      }
    }

    if (result.status === 'PENDING_APPROVAL') {
      return {
        ok: false,
        body: `Withdrawal requires approval before funds can move. Reference: ${result.approvalRequestId ?? 'pending approval'}.`,
        reference: result.approvalRequestId ?? null,
      }
    }

    return unavailable('withdrawal service did not return a transaction')
  } catch (error) {
    return unavailable('withdrawal service failed', error)
  }
}
