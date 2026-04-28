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
} from '@stellar/stellar-sdk';
import { getRpcServer, getNetworkPassphrase, getAgentKeypair, submitTransaction, waitForConfirmation } from './client';
import { getKeypairForUser } from './wallet';
import { OnChainBalance, TransactionResult } from './types';

const VAULT_CONTRACT_ID = process.env.VAULT_CONTRACT_ID || '';
const STROOPS_PER_TOKEN = 10_000_000n;

export type VaultWriteMethod = 'deposit' | 'withdraw';

/**
 * Get vault contract instance
 */
function getVaultContract(): Contract {
  if (!VAULT_CONTRACT_ID) {
    throw new Error('VAULT_CONTRACT_ID not configured');
  }
  return new Contract(VAULT_CONTRACT_ID);
}

/**
 * Build contract invocation transaction
 */
async function buildContractCall(
  method: string,
  args: xdr.ScVal[],
  sourcePublicKey: string = getAgentKeypair().publicKey(),
): Promise<Transaction> {
  const server = getRpcServer();
  const contract = getVaultContract();
  const account = await server.getAccount(sourcePublicKey);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: getNetworkPassphrase(),
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();
  return tx;
}

function toContractAmount(amount: number): bigint {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Amount must be a positive number');
  }

  return BigInt(Math.round(amount * Number(STROOPS_PER_TOKEN)));
}

async function executeWriteContractCall(
  method: string,
  args: xdr.ScVal[],
  signer: Keypair,
): Promise<TransactionResult> {
  const server = getRpcServer();
  const tx = await buildContractCall(method, args, signer.publicKey());

  // Pre-Transaction Simulation & Validation (Issue #58)
  const simulation = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error(`Transaction simulation failed for ${method}: ${simulation.error}`);
  }
  if (!simulation.result) {
    throw new Error(`Transaction simulation failed for ${method}: No result returned from simulation`);
  }

  const prepared = await server.prepareTransaction(tx);
  prepared.sign(signer);

  const txHash = await submitTransaction(prepared);
  const result = await waitForConfirmation(txHash);

  if (result.status !== 'success') {
    throw new Error(`Transaction ${method} failed on-chain`);
  }

  return result;
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
): Promise<TransactionResult> {
  const signer = await getKeypairForUser(userId);
  const userScVal = nativeToScVal(userAddress, { type: 'address' });
  const amountScVal = nativeToScVal(toContractAmount(amount), { type: 'i128' });
  const assetScVal = nativeToScVal(assetSymbol, { type: 'string' });

  return executeWriteContractCall(method, [userScVal, amountScVal, assetScVal], signer);
}

/**
 * Simulate and parse contract read call
 */
async function simulateRead(method: string, args: xdr.ScVal[] = []): Promise<any> {
  const server = getRpcServer();
  const tx = await buildContractCall(method, args);
  
  const simulation = await server.simulateTransaction(tx);
  
  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error(`Simulation failed: ${simulation.error}`);
  }
  
  if (!simulation.result) {
    throw new Error('No result from simulation');
  }
  
  return scValToNative(simulation.result.retval);
}

/**
 * Get on-chain balance for user
 */
export async function getOnChainBalance(userAddress: string): Promise<OnChainBalance> {
  const addressScVal = nativeToScVal(userAddress, { type: 'address' });
  const result = await simulateRead('get_balance', [addressScVal]);
  
  return {
    balance: result.balance?.toString() || '0',
    shares: result.shares?.toString() || '0',
  };
}

/**
 * Get current APY from vault
 */
export async function getOnChainAPY(): Promise<number> {
  const apyBasisPoints = await simulateRead('get_apy');
  return apyBasisPoints / 100; // Convert basis points to percentage
}

/**
 * Get active protocol
 */
export async function getActiveProtocol(): Promise<string> {
  return await simulateRead('get_active_protocol');
}

/**
 * Trigger rebalance (agent only)
 */
export async function triggerRebalance(
  protocol: string,
  expectedApyBasisPoints: number
): Promise<TransactionResult> {
  const protocolScVal = nativeToScVal(protocol, { type: 'string' });
  const apyScVal = nativeToScVal(expectedApyBasisPoints, { type: 'u32' });
  const keypair = getAgentKeypair();

  return executeWriteContractCall('rebalance', [protocolScVal, apyScVal], keypair);
}

/**
 * Update total assets (agent only)
 */
export async function updateTotalAssets(newTotalStroops: string): Promise<TransactionResult> {
  const amountScVal = nativeToScVal(BigInt(newTotalStroops), { type: 'i128' });
  const keypair = getAgentKeypair();

  return executeWriteContractCall('update_total_assets', [amountScVal], keypair);
}

/**
 * Submit a user-signed deposit transaction to the vault contract.
 */
export async function deposit(
  userId: string,
  userAddress: string,
  amount: number,
  assetSymbol: string,
): Promise<TransactionResult> {
  return depositForUser(userId, userAddress, amount, assetSymbol);
}

export async function depositForUser(
  userId: string,
  userAddress: string,
  amount: number,
  assetSymbol: string,
): Promise<TransactionResult> {
  return executeCustodialVaultOperation('deposit', userId, userAddress, amount, assetSymbol);
}

/**
 * Submit a user-signed withdrawal transaction to the vault contract.
 */
export async function withdraw(
  userId: string,
  userAddress: string,
  amount: number,
  assetSymbol: string,
): Promise<TransactionResult> {
  return withdrawForUser(userId, userAddress, amount, assetSymbol);
}

export async function withdrawForUser(
  userId: string,
  userAddress: string,
  amount: number,
  assetSymbol: string,
): Promise<TransactionResult> {
  return executeCustodialVaultOperation('withdraw', userId, userAddress, amount, assetSymbol);
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
  assetSymbol: string,
): Promise<string> {
  const server = getRpcServer();
  const userScVal = nativeToScVal(userAddress, { type: 'address' });
  const amountScVal = nativeToScVal(toContractAmount(amount), { type: 'i128' });
  const assetScVal = nativeToScVal(assetSymbol, { type: 'string' });

  const tx = await buildContractCall(method, [userScVal, amountScVal, assetScVal], userAddress);

  // Pre-Transaction Simulation & Validation (Issue #58)
  const simulation = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error(`Transaction simulation failed for ${method}: ${simulation.error}`);
  }
  if (!simulation.result) {
    throw new Error(`Transaction simulation failed for ${method}: No result returned from simulation`);
  }

  const prepared = await server.prepareTransaction(tx);

  return prepared.toXDR();
}
