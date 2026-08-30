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
import { Keypair, Asset, rpc } from '@stellar/stellar-sdk'
import {
  buildSponsoredCreateAccount,
  buildSponsoredTrustline,
  buildRevokeSponsorship,
  getSponsorKeypairs,
} from '../stellar/sponsorship'
import {
  submitTransaction,
  waitForConfirmation,
  prepareTransaction,
  simulateTransaction,
} from '../stellar/client'
import db from '../db'

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
    case 'sponsor_create_account':
    case 'sponsor_trustline':
    case 'revoke_sponsorship':
      return (payload as any).sponsorAccount as string
  }
}

function getSponsorKeypair(publicKey: string): Keypair {
  const kps = getSponsorKeypairs()
  const kp = kps.find((k) => k.publicKey() === publicKey)
  if (!kp) throw new Error(`Sponsor key not found for ${publicKey}`)
  return kp
}

async function submitSponsoredTransaction(
  tx: ReturnType<typeof buildSponsoredCreateAccount>,
  signer: Keypair
): Promise<TransactionResult> {
  const simulation = await simulateTransaction(tx as any)
  if (rpc.Api.isSimulationError(simulation as any)) {
    throw new Error(`Sponsorship simulation failed: ${(simulation as any).error}`)
  }
  const prepared = await prepareTransaction(tx as any)
  prepared.sign(signer)
  // Sponsored create also needs sponsored account signature? For createAccount with 0 balance sponsored, only sponsor signs. Add sponsored sig if needed? No.
  const hash = await submitTransaction(prepared)
  const result = await waitForConfirmation(hash)
  if ((result as any).status !== 'success' && (result as any).status !== undefined) {
    // waitForConfirmation returns {hash, status:'success'|...}
    if ((result as any).status === 'failed') throw new Error('Sponsored transaction failed on-chain')
  }
  return result
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
    case 'sponsor_create_account': {
      const sponsor = getSponsorKeypair(payload.sponsorAccount)
      const tx = buildSponsoredCreateAccount({
        newAccountId: payload.newAccountId,
        sponsorKeypair: sponsor,
        startingBalance: '0',
      })
      const result = await submitSponsoredTransaction(tx, sponsor)
      // Record reserve ledger on success (best-effort, backfillable via reconciliation)
      await (db as any).reserveSponsorship
        .create({
          data: {
            sponsoredId: payload.sponsoredId,
            sponsorAccount: payload.sponsorAccount,
            entryType: 'ACCOUNT',
            ledgerKey: payload.ledgerKey,
            xlmReserved: payload.xlmReserved,
            status: 'ACTIVE',
          },
        })
        .catch(() => {})
      return result
    }
    case 'sponsor_trustline': {
      const sponsor = getSponsorKeypair(payload.sponsorAccount)
      const asset = new Asset(payload.assetCode, payload.assetIssuer)
      const tx = buildSponsoredTrustline({
        accountId: payload.accountId,
        asset,
        sponsorKeypair: sponsor,
      })
      const result = await submitSponsoredTransaction(tx, sponsor)
      await (db as any).reserveSponsorship
        .create({
          data: {
            sponsoredId: payload.sponsoredId,
            sponsorAccount: payload.sponsorAccount,
            entryType: 'TRUSTLINE',
            ledgerKey: payload.ledgerKey,
            xlmReserved: payload.xlmReserved,
            status: 'ACTIVE',
          },
        })
        .catch(() => {})
      return result
    }
    case 'revoke_sponsorship': {
      const sponsor = getSponsorKeypair(payload.sponsorAccount)
      const tx = buildRevokeSponsorship({
        sponsorKeypair: sponsor,
        accountId: payload.sponsoredId,
        ledgerKey: payload.ledgerKey,
      })
      const result = await submitSponsoredTransaction(tx, sponsor)
      await (db as any).reserveSponsorship
        .updateMany({
          where: { ledgerKey: payload.ledgerKey, status: 'ACTIVE' },
          data: { status: 'RECLAIMED', revokedAt: new Date() },
        })
        .catch(() => {})
      return result
    }
  }
}
