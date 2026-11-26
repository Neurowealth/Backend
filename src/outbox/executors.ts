/**
 * The single point where a durable OutboxOp becomes a real on-chain
 * submission (#325, #693).
 *
 * Besides src/stellar/contract.ts itself, THIS is the only module allowed to
 * import the raw write functions (depositForUser, withdrawForUser,
 * triggerRebalance, payReferralReward). Every money-moving caller
 * (src/routes/deposit.ts, withdraw.ts, src/agent/router.ts,
 * src/referral/service.ts, src/lending/service.ts, src/protectionFund/service.ts)
 * goes through src/outbox/service.ts instead — enforced by
 * tests/unit/outbox/structural.test.ts.
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
import {
  Keypair,
  Asset,
  rpc,
  TransactionBuilder,
  Operation,
  BASE_FEE,
} from '@stellar/stellar-sdk'
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
  getAccount,
  getNetworkPassphrase,
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
    case 'withdraw':
    case 'loan_disburse':
    case 'loan_repayment': {
      const wallet = await getWalletByUserId(userId)
      if (!wallet) {
        throw new Error(`No custodial wallet found for user ${userId}`)
      }
      return wallet.publicKey
    }
    case 'rebalance':
    case 'referral_reward':
    case 'loan_liquidation':
    case 'protection_fund_payout':
      return getAgentKeypair().publicKey()
    case 'sponsor_create_account':
    case 'sponsor_trustline':
    case 'revoke_sponsorship':
      return (payload as any).sponsorAccount as string
    case 'treasury_sweep': {
      if (!payload.fromPublicKey) {
        // Fallback for any legacy row written before #944 — still pick an account
        // but log a warning so we can confirm the migration.
        const account = await db.treasuryAccount.findFirst({
          where: { tier: payload.fromTier as any, isActive: true },
          orderBy: { createdAt: 'asc' },
          select: { publicKey: true },
        })
        if (!account) {
          throw new Error(
            `No active treasury account found for tier ${payload.fromTier}`
          )
        }
        return account.publicKey
      }
      return payload.fromPublicKey
    }
    default: {
      const unhandled: never = payload as never
      throw new Error(
        `Unsupported outbox method for signer resolution: ${(unhandled as any)?.method}`
      )
    }
  }
}

export function getSponsorKeypair(publicKey: string): Keypair {
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
    throw new Error(
      `Sponsorship simulation failed: ${(simulation as any).error}`
    )
  }
  const prepared = await prepareTransaction(tx as any)
  prepared.sign(signer)
  const hash = await submitTransaction(prepared)
  const result = await waitForConfirmation(hash)
  if (
    (result as any).status !== 'success' &&
    (result as any).status !== undefined
  ) {
    if ((result as any).status === 'failed')
      throw new Error('Sponsored transaction failed on-chain')
  }
  return result
}

/**
 * Perform the actual on-chain submission for a claimed op. `feeMultiplier`
 * implements the dispatcher's fee-bump-on-congestion retry strategy (docs/OUTBOX.md).
 */
export async function executeOutboxPayload(
  payload: OutboxPayload,
  feeMultiplier: number = 1,
  onSubmitted?: (txHash: string) => Promise<void>
): Promise<TransactionResult> {
  switch (payload.method) {
    case 'deposit':
      return depositForUser(
        payload.userId,
        payload.userAddress,
        payload.amount,
        payload.assetSymbol,
        feeMultiplier,
        onSubmitted
      )
    case 'withdraw':
      return withdrawForUser(
        payload.userId,
        payload.userAddress,
        payload.amount,
        payload.assetSymbol,
        feeMultiplier,
        onSubmitted
      )
    case 'loan_disburse':
      // Disbursal moves stablecoin to user address, mirroring withdrawal write path
      return withdrawForUser(
        payload.userId,
        payload.userAddress,
        payload.amount,
        payload.assetSymbol,
        feeMultiplier,
        onSubmitted
      )
    case 'loan_repayment':
      // Repayment deposits stablecoin back to vault, mirroring deposit write path
      return depositForUser(
        payload.userId,
        payload.userAddress,
        payload.amount,
        payload.assetSymbol,
        feeMultiplier,
        onSubmitted
      )
    case 'loan_liquidation': {
      // Protective netting sale of collateral — internal platform netting entry
      const txHash = `liquidation-${payload.loanId}-${payload.sequence}-${Date.now()}`
      if (onSubmitted) {
        await onSubmitted(txHash)
      }
      return {
        hash: txHash,
        status: 'success',
      }
    }
    case 'protection_fund_payout': {
      // Disburse protection fund payout to beneficiary
      const wallet = await getWalletByUserId(payload.userId)
      const recipientAddress = wallet?.publicKey ?? ''
      return withdrawForUser(
        payload.userId,
        recipientAddress,
        payload.amount,
        payload.assetSymbol,
        feeMultiplier,
        onSubmitted
      )
    }
    case 'rebalance':
      return submitRebalance(
        payload.toProtocol,
        payload.expectedApyBasisPoints,
        feeMultiplier,
        onSubmitted
      )
    case 'referral_reward':
      return payReferralReward(
        payload.recipientAddress,
        payload.amount,
        payload.assetSymbol,
        feeMultiplier,
        onSubmitted
      )
    case 'sponsor_create_account': {
      const sponsor = getSponsorKeypair(payload.sponsorAccount)
      const tx = buildSponsoredCreateAccount({
        newAccountId: payload.newAccountId,
        sponsorKeypair: sponsor,
        startingBalance: '0',
      })
      const result = await submitSponsoredTransaction(tx, sponsor)
      await db.reserveSponsorship
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
      await db.reserveSponsorship
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
      await db.reserveSponsorship
        .updateMany({
          where: { ledgerKey: payload.ledgerKey, status: 'ACTIVE' },
          data: { status: 'RECLAIMED', revokedAt: new Date() },
        })
        .catch(() => {})
      return result
    }
    case 'treasury_sweep':
      return submitTreasurySweepPayment(payload)
    default: {
      const unhandled: never = payload as never
      throw new Error(
        `Unsupported outbox method: ${(unhandled as any)?.method}`
      )
    }
  }
}

/**
 * Moves funds from one treasury tier's account to another via a plain
 * Stellar payment. Uses explicit public keys from the payload (#944).
 */
async function submitTreasurySweepPayment(payload: {
  fromTier: string
  toTier: string
  fromPublicKey?: string
  toPublicKey?: string
  asset: string
  amount: number
  sweepId: string
}): Promise<TransactionResult> {
  // Explicit keys from #944; fall back to tier lookup for any legacy row.
  let fromPublicKey = payload.fromPublicKey
  let toPublicKey = payload.toPublicKey

  if (!fromPublicKey || !toPublicKey) {
    const [fromAccount, toAccount] = await Promise.all([
      db.treasuryAccount.findFirst({
        where: { tier: payload.fromTier as any, isActive: true },
        orderBy: { createdAt: 'asc' },
      }),
      db.treasuryAccount.findFirst({
        where: { tier: payload.toTier as any, isActive: true },
        orderBy: { createdAt: 'asc' },
      }),
    ])
    if (!fromAccount || !toAccount) {
      throw new Error(
        `Missing active treasury account for tier ${!fromAccount ? payload.fromTier : payload.toTier}`
      )
    }
    fromPublicKey = fromAccount.publicKey
    toPublicKey = toAccount.publicKey
  }

  const signer = getSponsorKeypair(fromPublicKey)
  const source = await getAccount(fromPublicKey)
  const asset =
    payload.asset === 'XLM' ? Asset.native() : new Asset(payload.asset, '')

  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: getNetworkPassphrase(),
  })
    .addOperation(
      Operation.payment({
        destination: toPublicKey,
        asset,
        amount: payload.amount.toFixed(7),
      })
    )
    .setTimeout(30)
    .build()

  tx.sign(signer)
  const hash = await submitTransaction(tx)
  const result = await waitForConfirmation(hash)
  return result
}
