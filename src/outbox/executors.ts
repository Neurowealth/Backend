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
  getAccount,
  getNetworkPassphrase,
} from '../stellar/client'
import db from '../db'
import { applyLoanLiquidationSale } from '../lending/liquidation'

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
      const account = await db.treasuryAccount.findFirst({
        where: { tier: payload.fromTier as any, isActive: true },
        select: { publicKey: true },
      })
      if (!account) {
        throw new Error(
          `No active treasury account found for tier ${payload.fromTier}`
        )
      }
      return account.publicKey
    }
    case 'treasury_signer_rotation': {
      // The source account of the setOptions transaction is the treasury
      // account itself (its address never changes on a Stellar signer
      // rotation), so sequence-number locking must use that address.
      const account = await db.treasuryAccount.findUnique({
        where: { id: payload.treasuryAccountId },
        select: { publicKey: true },
      })
      if (!account) {
        throw new Error(
          `Treasury account ${payload.treasuryAccountId} not found for rotation ${payload.rotationId}`
        )
      }
      return account.publicKey
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
  // These are classic (non-Soroban) transactions — BeginSponsoringFutureReserves,
  // CreateAccount, ChangeTrust, RevokeSponsorship — which simulateTransaction /
  // prepareTransaction cannot handle (Soroban simulate only supports a single
  // InvokeHostFunction op). Sign and submit directly instead.
  tx.sign(signer)
  const hash = await submitTransaction(tx as any)
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
      // Protective netting sale of collateral — an internal ledger entry,
      // not a Stellar transfer. applyLoanLiquidationSale performs the whole
      // sale atomically and returns a namespaced platform reference.
      const result = await applyLoanLiquidationSale(payload)
      if (onSubmitted && result.hash) {
        await onSubmitted(result.hash)
      }
      return result
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
      const sponsorAccount = await getAccount(sponsor.publicKey())
      const tx = buildSponsoredCreateAccount({
        newAccountId: payload.newAccountId,
        sponsorKeypair: sponsor,
        startingBalance: '0',
        sponsorSequence: sponsorAccount.sequenceNumber(),
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
      const sponsorAccount = await getAccount(sponsor.publicKey())
      const asset = new Asset(payload.assetCode, payload.assetIssuer)
      const tx = buildSponsoredTrustline({
        accountId: payload.accountId,
        asset,
        sponsorKeypair: sponsor,
        sponsorSequence: sponsorAccount.sequenceNumber(),
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
      const sponsorAccount = await getAccount(sponsor.publicKey())
      const tx = buildRevokeSponsorship({
        sponsorKeypair: sponsor,
        accountId: payload.sponsoredId,
        ledgerKey: payload.ledgerKey,
        sponsorSequence: sponsorAccount.sequenceNumber(),
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
    case 'treasury_signer_rotation':
      return submitTreasurySignerRotation(payload)
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
 * Stellar payment.
 */
async function submitTreasurySweepPayment(payload: {
  fromTier: string
  toTier: string
  asset: string
  amount: number
  sweepId: string
}): Promise<TransactionResult> {
  const [fromAccount, toAccount] = await Promise.all([
    db.treasuryAccount.findFirst({
      where: { tier: payload.fromTier as any, isActive: true },
    }),
    db.treasuryAccount.findFirst({
      where: { tier: payload.toTier as any, isActive: true },
    }),
  ])
  if (!fromAccount || !toAccount) {
    throw new Error(
      `Missing active treasury account for tier ${!fromAccount ? payload.fromTier : payload.toTier}`
    )
  }

  const signer = getSponsorKeypair(fromAccount.publicKey)
  const source = await getAccount(fromAccount.publicKey)
  const asset =
    payload.asset === 'XLM' ? Asset.native() : new Asset(payload.asset, '')

  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: getNetworkPassphrase(),
  })
    .addOperation(
      Operation.payment({
        destination: toAccount.publicKey,
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

/**
 * Finalize a signer rotation on-chain (#752).
 *
 * Stellar signers are entries ON the treasury account: rotating a key must
 * never rewrite TreasuryAccount.publicKey (that is the account address that
 * sweeps send to and that signs sweeps out). Emit two setOptions operations in
 * one transaction — add the new key first so signing capacity is never
 * reduced, then remove the old one — and sign with every configured treasury
 * signer key (each configured key is one multisig approval; production runs
 * more than one).
 */
async function submitTreasurySignerRotation(payload: {
  rotationId: string
  treasuryAccountId: string
  oldSignerKey: string
  newSignerKey: string
}): Promise<TransactionResult> {
  const account = await db.treasuryAccount.findUnique({
    where: { id: payload.treasuryAccountId },
  })
  if (!account) {
    throw new Error(
      `Treasury account ${payload.treasuryAccountId} not found for rotation ${payload.rotationId}`
    )
  }

  const source = await getAccount(account.publicKey)
  const signers = getSponsorKeypairs()
  if (signers.length === 0) {
    throw new Error(
      'No treasury signer keys configured for signer rotation submission'
    )
  }

  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: getNetworkPassphrase(),
  })
    .addOperation(
      Operation.setOptions({
        signer: { ed25519PublicKey: payload.newSignerKey, weight: 1 },
      })
    )
    .addOperation(
      Operation.setOptions({
        signer: { ed25519PublicKey: payload.oldSignerKey, weight: 0 },
      })
    )
    .setTimeout(30)
    .build()

  tx.sign(...signers)
  const hash = await submitTransaction(tx)
  return waitForConfirmation(hash)
}
