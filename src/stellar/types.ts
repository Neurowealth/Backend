import { xdr } from '@stellar/stellar-sdk';
import { Network } from '@prisma/client';

export interface ContractEvent {
  type: 'deposit' | 'withdraw' | 'rebalance';
  ledger: number;
  txHash: string;
  contractId: string;
  topics: xdr.ScVal[];
  value: xdr.ScVal;
}

export interface DepositEvent {
  user: string;
  amount: string;
  shares: string;
  assetSymbol: string;
  protocolName: string;
  network: Network;
}

export interface WithdrawEvent {
  user: string;
  amount: string;
  shares: string;
  assetSymbol: string;
  protocolName: string;
  network: Network;
}

export interface RebalanceEvent {
  protocol: string;
  apy: number;
  timestamp: number;
  assetSymbol: string;
  network: Network;
}

export interface EventMetrics {
  totalProcessed: number;
  totalErrors: number;
  processingRatePerMinute: number;
  errorRate: number;
  ledgerLag: number;
  lastDbOperationMs: number;
  lastUpdated: Date;
}

export interface TransactionResult {
  hash: string;
  status: 'success' | 'failed';
  ledger?: number;
}

export interface OnChainBalance {
  balance: string;
  shares: string;
}

export interface VaultState {
  totalAssets: string;
  apy: number;
  activeProtocol: string;
}
