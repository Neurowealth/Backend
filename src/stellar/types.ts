import { xdr } from '@stellar/stellar-sdk'
import { Network } from '@prisma/client'

export interface ContractEvent {
  type: 'deposit' | 'withdraw' | 'rebalance'
  ledger: number
  txHash: string
  contractId: string
  topics: xdr.ScVal[]
  value: xdr.ScVal
}

export interface DepositEvent {
  user: string
  amount: string
  shares: string
  assetSymbol: string
  protocolName: string
  network: Network
}

export interface WithdrawEvent {
  user: string
  amount: string
  shares: string
  assetSymbol: string
  protocolName: string
  network: Network
}

export interface RebalanceEvent {
  protocol: string
  apy: number
  timestamp: number
  assetSymbol: string
  network: Network
}

export interface EventMetrics {
  totalProcessed: number
  totalErrors: number
  processingRatePerMinute: number
  errorRate: number
  ledgerLag: number
  lastDbOperationMs: number
  lastUpdated: Date
}

export interface TransactionResult {
  hash: string
  status: 'success' | 'failed' | 'pending'
  ledger?: number
  /**
   * The op resolved without moving anything (e.g. a liquidation whose loan
   * healed or was already settled, #823). The outbox op still confirms, but
   * the linked Transaction must not be reported as a completed movement.
   */
  skipped?: boolean
}

export class TransactionConfirmationTimeoutError extends Error {
  constructor(
    public readonly txHash: string,
    timeoutMs: number,
    cause?: unknown
  ) {
    super(
      `Transaction confirmation timeout after ${timeoutMs}ms (hash: ${txHash})`
    )
    this.name = 'TransactionConfirmationTimeoutError'
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', { value: cause, configurable: true })
    }
  }
}

export interface OnChainBalance {
  balance: string
  shares: string
}

export interface VaultState {
  totalAssets: string
  apy: number
  activeProtocol: string
}
