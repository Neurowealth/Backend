import {
  Keypair,
  Contract,
  rpc,
  TransactionBuilder,
  Transaction,
  BASE_FEE,
  xdr,
  scValToNative,
  nativeToScVal,
} from '@stellar/stellar-sdk'
import {
  getRpcServer,
  getNetworkPassphrase,
  getAgentKeypair,
  submitTransaction,
  waitForConfirmation,
  simulateTransaction,
  prepareTransaction,
  getAccount,
} from './client'
import { getKeypairForUser } from './wallet'
import { config } from '../config'
import { OnChainBalance, TransactionResult } from './types'
import {
  MAX_CONTRACT_AMOUNT,
  STROOPS_PER_TOKEN,
} from '../config/financial-limits'

const VAULT_CONTRACT_ID = config.stellar.vaultContractId

export type VaultWriteMethod = 'deposit' | 'withdraw'

/**
 * Get vault contract instance
 */
function getVaultContract(): Contract {
  if (!VAULT_CONTRACT_ID) {
    throw new Error('VAULT_CONTRACT_ID not configured')
  }
  return new Contract(VAULT_CONTRACT_ID)
}

/**
 * Compute the transaction fee (in stroops, as a string) for a given
 * multiplier over BASE_FEE. Shared by all transaction builders so fee-bump
 * retries behave identically across contract calls, treasury sweeps, and
 * sponsored-reserve transactions.
 */
export function computeFee(feeMultiplier: number = 1): string {
  return feeMultiplier === 1
    ? BASE_FEE
    : String(
        BigInt(BASE_FEE) * BigInt(Math.max(1, Math.round(feeMultiplier)))
      )
}

/**
 * Build contract invocation transaction.
 *
 * `feeMultiplier` scales the base fee (default 1x). The outbox dispatcher
 * (#325) resubmits a congested-network op at a higher multiplier — fee-bump
 * strategy documented in docs/OUTBOX.md — up to a configured cap.
 */
async function buildContractCall(
  method: string,
  args: xdr.ScVal[],
  sourcePublicKey: string = getAgentKeypair().publicKey(),
  feeMultiplier: number = 1
): Promise<Transaction> {
  const server = getRpcServer()
  const contract = getVaultContract()
  const account = await getAccount(sourcePublicKey)
  const fee = computeFee(feeMultiplier)

  const tx = new TransactionBuilder(account, {
    fee,
    networkPassphrase: getNetworkPassphrase(),
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build()
  return tx
}

// Number of decimal places one stroop represents (10^7 stroops per token).
const STROOPS_DECIMALS = 7

/**
 * Expand IEEE-754 exponent notation ("1e-7", "1.5e+3") into plain decimal
 * notation so the string can be split on '.' unambiguously.
 */
function expandExponential(decimal: string): string {
  if (!/[eE]/.test(decimal)) return decimal
  const [mantissa, exponent] = decimal.toLowerCase().split('e')
  const exp = parseInt(exponent, 10)
  const negative = mantissa.startsWith('-')
  const unsigned = negative ? mantissa.slice(1) : mantissa
  const dotIndex = unsigned.indexOf('.')
  const intPart = dotIndex === -1 ? unsigned : unsigned.slice(0, dotIndex)
  const fracPart = dotIndex === -1 ? '' : unsigned.slice(dotIndex + 1)
  const digits = intPart + fracPart
  const pointPos = intPart.length + exp
  let result: string
  if (pointPos <= 0) {
    result = `0.${'0'.repeat(-pointPos)}${digits}`
  } else if (pointPos >= digits.length) {
    result = digits + '0'.repeat(pointPos - digits.length)
  } else {
    result = `${digits.slice(0, pointPos)}.${digits.slice(pointPos)}`
  }
  return (negative ? '-' : '') + result
}

function toContractAmount(amount: number): bigint {
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_CONTRACT_AMOUNT) {
    throw new Error(
      `Amount must be finite, positive, and no greater than ${MAX_CONTRACT_AMOUNT}`
    )
  }

  // Convert via the decimal string, not float multiplication (#741):
  // 19.99 * 1e7 === 199899999.99999997 in IEEE-754, which fails an
  // isSafeInteger check even though 19.99 is a perfectly valid amount.
  const [whole, fraction = ''] = expandExponential(amount.toString()).split('.')
  if (fraction.length > STROOPS_DECIMALS) {
    throw new Error(
      `Amount must have at most ${STROOPS_DECIMALS} decimal places`
    )
  }

  return (
    BigInt(whole) * BigInt(STROOPS_PER_TOKEN) +
    BigInt(fraction.padEnd(STROOPS_DECIMALS, '0'))
  )
}

async function executeWriteContractCall(
  method: string,
  args: xdr.ScVal[],
  signer: Keypair,
  feeMultiplier: number = 1,
  onSubmitted?: (txHash: string) => Promise<void>
): Promise<TransactionResult> {
  const tx = await buildContractCall(
    method,
    args,
    signer.publicKey(),
    feeMultiplier
  )

  // Pre-Transaction Simulation & Validation (Issue #58)
  const simulation = await simulateTransaction(tx)
  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error(
      `Transaction simulation failed for ${method}: ${simulation.error}`
    )
  }
  if (!simulation.result) {
    throw new Error(
      `Transaction simulation failed for ${method}: No result returned from simulation`
    )
  }

  const prepared = await prepareTransaction(tx)
  prepared.sign(signer)

  const txHash = await submitTransaction(prepared)
  await onSubmitted?.(txHash)
  const result = await waitForConfirmation(txHash)

  // A resolved `status: 'failed'` is returned, not thrown (#744): the
  // dispatcher's terminal-failure branch records the txHash and marks the
  // op FAILED without retrying, instead of the error falling into the
  // transient retry/backoff path.
  return result
}

/**
 * Execute a custodial user operation against the vault contract.
 *
 * Signing strategy:
 * - The backend uses the encrypted user secret managed by src/stellar/wallet.ts
 * - Only the public address is passed to the contract arguments
 * - User secrets are never logged or returned from this module
 */
async function executeCustodialVaultOperation(
  method: VaultWriteMethod,
  userId: string,
  userAddress: string,
  amount: number,
  assetSymbol: string,
  feeMultiplier: number = 1,
  onSubmitted?: (txHash: string) => Promise<void>
): Promise<TransactionResult> {
  const signer = await getKeypairForUser(userId)
  const userScVal = nativeToScVal(userAddress, { type: 'address' })
  const amountScVal = nativeToScVal(toContractAmount(amount), { type: 'i128' })
  const assetScVal = nativeToScVal(assetSymbol, { type: 'string' })

  return executeWriteContractCall(
    method,
    [userScVal, amountScVal, assetScVal],
    signer,
    feeMultiplier,
    onSubmitted
  )
}

/**
 * Simulate and parse contract read call
 */
async function simulateRead(
  method: string,
  args: xdr.ScVal[] = []
): Promise<any> {
  const tx = await buildContractCall(method, args)

  const simulation = await simulateTransaction(tx)

  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error(`Simulation failed: ${simulation.error}`)
  }

  if (!simulation.result) {
    throw new Error('No result from simulation')
  }

  return scValToNative(simulation.result.retval)
}

/**
 * Get on-chain balance for user
 */
export async function getOnChainBalance(
  userAddress: string
): Promise<OnChainBalance> {
  const addressScVal = nativeToScVal(userAddress, { type: 'address' })
  const result = await simulateRead('get_balance', [addressScVal])

  return {
    balance: result.balance?.toString() || '0',
    shares: result.shares?.toString() || '0',
  }
}

/**
 * Get current APY from vault
 */
export async function getOnChainAPY(): Promise<number> {
  const apyBasisPoints = await simulateRead('get_apy')
  return apyBasisPoints / 100 // Convert basis points to percentage
}

/**
 * Get active protocol
 */
export async function getActiveProtocol(): Promise<string> {
  return await simulateRead('get_active_protocol')
}

/**
 * Trigger rebalance (agent only)
 */
export async function triggerRebalance(
  protocol: string,
  expectedApyBasisPoints: number,
  feeMultiplier: number = 1,
  onSubmitted?: (txHash: string) => Promise<void>
): Promise<TransactionResult> {
  const protocolScVal = nativeToScVal(protocol, { type: 'string' })
  const apyScVal = nativeToScVal(expectedApyBasisPoints, { type: 'u32' })
  const keypair = getAgentKeypair()

  return executeWriteContractCall(
    'rebalance',
    [protocolScVal, apyScVal],
    keypair,
    feeMultiplier,
    onSubmitted
  )
}

/**
 * Update total assets (agent only)
 */
export async function updateTotalAssets(
  newTotalStroops: string
): Promise<TransactionResult> {
  const amountScVal = nativeToScVal(BigInt(newTotalStroops), { type: 'i128' })
  const keypair = getAgentKeypair()

  return executeWriteContractCall('update_total_assets', [amountScVal], keypair)
}

/**
 * Pay a referral reward into a user's wallet (agent-signed, platform-funded).
 *
 * Reuses the same on-chain write path as withdrawals/rebalancing
 * (executeWriteContractCall) rather than introducing a second money-movement
 * mechanism. The reward moves platform/treasury funds to `recipientAddress`;
 * it is NOT a withdrawal of the user's own capital.
 *
 * The contract method name is configurable (config.referral.rewardContractMethod)
 * so this backend does not hard-code a method that may be renamed in the
 * contract repo. Signed by the agent keypair.
 *
 * @returns the TransactionResult; caller records the resulting txHash on the
 *          ReferralConversion. Throws on simulation/submission failure so the
 *          caller can leave the payout in a retriable state.
 */
export async function payReferralReward(
  recipientAddress: string,
  amount: number,
  assetSymbol: string,
  feeMultiplier: number = 1,
  onSubmitted?: (txHash: string) => Promise<void>
): Promise<TransactionResult> {
  const recipientScVal = nativeToScVal(recipientAddress, { type: 'address' })
  const amountScVal = nativeToScVal(toContractAmount(amount), { type: 'i128' })
  const assetScVal = nativeToScVal(assetSymbol, { type: 'string' })
  const keypair = getAgentKeypair()

  return executeWriteContractCall(
    config.referral.rewardContractMethod,
    [recipientScVal, amountScVal, assetScVal],
    keypair,
    feeMultiplier,
    onSubmitted
  )
}

/**
 * Submit a user-signed deposit transaction to the vault contract.
 */
export async function deposit(
  userId: string,
  userAddress: string,
  amount: number,
  assetSymbol: string
): Promise<TransactionResult> {
  return depositForUser(userId, userAddress, amount, assetSymbol)
}

export async function depositForUser(
  userId: string,
  userAddress: string,
  amount: number,
  assetSymbol: string,
  feeMultiplier: number = 1,
  onSubmitted?: (txHash: string) => Promise<void>
): Promise<TransactionResult> {
  return executeCustodialVaultOperation(
    'deposit',
    userId,
    userAddress,
    amount,
    assetSymbol,
    feeMultiplier,
    onSubmitted
  )
}

/**
 * Submit a user-signed withdrawal transaction to the vault contract.
 */
export async function withdraw(
  userId: string,
  userAddress: string,
  amount: number,
  assetSymbol: string
): Promise<TransactionResult> {
  return withdrawForUser(userId, userAddress, amount, assetSymbol)
}

export async function withdrawForUser(
  userId: string,
  userAddress: string,
  amount: number,
  assetSymbol: string,
  feeMultiplier: number = 1,
  onSubmitted?: (txHash: string) => Promise<void>
): Promise<TransactionResult> {
  return executeCustodialVaultOperation(
    'withdraw',
    userId,
    userAddress,
    amount,
    assetSymbol,
    feeMultiplier,
    onSubmitted
  )
}

/**
 * Build an unsigned XDR transaction for non-custodial signing.
 * The backend constructs and prepares the transaction but never signs it.
 * The client (e.g. Freighter) signs and submits the returned XDR.
 */
export async function buildUnsignedVaultTransaction(
  method: VaultWriteMethod,
  userAddress: string,
  amount: number,
  assetSymbol: string
): Promise<string> {
  const userScVal = nativeToScVal(userAddress, { type: 'address' })
  const amountScVal = nativeToScVal(toContractAmount(amount), { type: 'i128' })
  const assetScVal = nativeToScVal(assetSymbol, { type: 'string' })

  const tx = await buildContractCall(
    method,
    [userScVal, amountScVal, assetScVal],
    userAddress
  )

  // Pre-Transaction Simulation & Validation (Issue #58)
  const simulation = await simulateTransaction(tx)
  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error(
      `Transaction simulation failed for ${method}: ${simulation.error}`
    )
  }
  if (!simulation.result) {
    throw new Error(
      `Transaction simulation failed for ${method}`
    )
  }

  const prepared = await prepareTransaction(tx)
  return prepared.toXDR()
}
