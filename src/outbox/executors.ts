/**
 * The single point where a durable OutboxOp becomes a real on-chain
 * submission (#325).
 *
 * Besides src/stellar/contract.ts itself, THIS is the only module allowed to
 * import the raw write functions (depositForUser, withdrawForUser,
 * triggerRebalance, payReferralReward). Every money-moving caller
 * (src/routes/deposit.ts, withdraw.ts, src/agent/router.ts,
 * src/referral/service.ts) goes through src/outbox/service.ts instead —
 * enforced by tests/unit/outbox/structural.test.ts, which fails CI the
 * moment a new caller bypasses the outbox.
 */

import {
  depositForUser,
  withdrawForUser,
  triggerRebalance as submitRebalance,
  payReferralReward,
} from '../stellar/contract'
import { getWalletByUserId } from '../stellar/wallet'
import { getAgentKeypair } from '../stellar/client'
import { TransactionResult } from '../stellar/types'
import { OutboxPayload } from './types'

/**
 * Which Stellar public key an op's submission will sign with — resolved
 * without decrypting anything, so the dispatcher can serialize per-signer
 * (src/outbox/signerLock.ts) before it commits to actually claiming the op.
 */
export async function resolveSignerPublicKey(
  payload: OutboxPayload,
  userId: string
): Promise<string> {
  switch (payload.method) {
    case 'deposit':
    case 'withdraw': {
      const wallet = await getWalletByUserId(userId)
      if (!wallet) {
        throw new Error(`No custodial wallet found for user ${userId}`)
      }
      return wallet.publicKey
    }
    case 'rebalance':
    case 'referral_reward':
      return getAgentKeypair().publicKey()
  }
}

/**
 * Perform the actual on-chain submission for a claimed op. `feeMultiplier`
 * implements the dispatcher's fee-bump-on-congestion retry strategy (docs/OUTBOX.md).
 */
export async function executeOutboxPayload(
  payload: OutboxPayload,
  feeMultiplier: number = 1
): Promise<TransactionResult> {
  switch (payload.method) {
    case 'deposit':
      return depositForUser(
        payload.userId,
        payload.userAddress,
        payload.amount,
        payload.assetSymbol,
        feeMultiplier
      )
    case 'withdraw':
      return withdrawForUser(
        payload.userId,
        payload.userAddress,
        payload.amount,
        payload.assetSymbol,
        feeMultiplier
      )
    case 'rebalance':
      return submitRebalance(
        payload.toProtocol,
        payload.expectedApyBasisPoints,
        feeMultiplier
      )
    case 'referral_reward':
      return payReferralReward(
        payload.recipientAddress,
        payload.amount,
        payload.assetSymbol,
        feeMultiplier
      )
  }
}
