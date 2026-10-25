/**
 * Stellar Contract & Schema Drift Detection Engine (#508)
 *
 * Validates deployed Stellar contract IDs, network RPC endpoints, network passphrases,
 * secret key formatting, and app assumption metadata to prevent silent integration drift.
 */

import { StrKey } from '@stellar/stellar-sdk'
import { resolveNetworkPassphrase } from './client'
import { logger } from '../utils/logger'

export interface DriftIssue {
  component: 'network' | 'contract' | 'secret' | 'env'
  field: string
  expected: string
  actual: string
  severity: 'error' | 'warning'
  description: string
}

export interface DriftCheckReport {
  timestamp: string
  network: string
  driftDetected: boolean
  drifts: DriftIssue[]
  checksPassed: number
  totalChecks: number
}

export interface StellarDriftConfig {
  network?: string
  rpcUrl?: string
  vaultContractId?: string
  usdcTokenAddress?: string
  agentSecretKey?: string
}

const EXPECTED_DEFAULT_RPCS: Record<string, string> = {
  mainnet: 'https://soroban-mainnet.stellar.org',
  testnet: 'https://soroban-testnet.stellar.org',
  futurenet: 'https://rpc-futurenet.stellar.org',
}

/**
 * Perform comprehensive Stellar integration drift checks against environment configuration
 */
export function checkStellarIntegrationDrift(
  customConfig?: StellarDriftConfig
): DriftCheckReport {
  const envNetwork = (
    customConfig?.network ||
    process.env.STELLAR_NETWORK ||
    'testnet'
  ).toLowerCase()
  const rpcUrl =
    customConfig?.rpcUrl ||
    process.env.STELLAR_RPC_URL ||
    process.env.STELLAR_RPC_URLS ||
    ''
  const vaultContractId =
    customConfig?.vaultContractId || process.env.VAULT_CONTRACT_ID || ''
  const usdcTokenAddress =
    customConfig?.usdcTokenAddress || process.env.USDC_TOKEN_ADDRESS || ''
  const agentSecretKey =
    customConfig?.agentSecretKey || process.env.STELLAR_AGENT_SECRET_KEY || ''

  const drifts: DriftIssue[] = []
  let checksPassed = 0
  let totalChecks = 0

  // 1. Network Name Validation
  totalChecks++
  if (!['mainnet', 'testnet', 'futurenet'].includes(envNetwork)) {
    drifts.push({
      component: 'network',
      field: 'STELLAR_NETWORK',
      expected: 'mainnet | testnet | futurenet',
      actual: envNetwork,
      severity: 'error',
      description: `Unsupported Stellar network '${envNetwork}'`,
    })
  } else {
    checksPassed++
  }

  // 2. Network Passphrase Consistency Check
  totalChecks++
  try {
    const passphrase = resolveNetworkPassphrase(envNetwork)
    if (!passphrase || passphrase.trim().length === 0) {
      drifts.push({
        component: 'network',
        field: 'networkPassphrase',
        expected: 'Valid Stellar Network Passphrase',
        actual: 'empty',
        severity: 'error',
        description: `Passphrase resolution failed for network '${envNetwork}'`,
      })
    } else {
      checksPassed++
    }
  } catch (err: any) {
    drifts.push({
      component: 'network',
      field: 'networkPassphrase',
      expected: 'Valid Stellar Network Passphrase',
      actual: err.message,
      severity: 'error',
      description: `Passphrase resolution threw error: ${err.message}`,
    })
  }

  // 3. RPC URL Alignment Check
  totalChecks++
  if (!rpcUrl) {
    drifts.push({
      component: 'network',
      field: 'STELLAR_RPC_URL',
      expected: 'Non-empty valid RPC URL',
      actual: 'missing',
      severity: 'error',
      description: 'Stellar RPC URL is not configured in environment',
    })
  } else {
    // Check for network mismatch in RPC URL
    if (
      envNetwork === 'mainnet' &&
      (rpcUrl.includes('testnet') || rpcUrl.includes('futurenet'))
    ) {
      drifts.push({
        component: 'network',
        field: 'STELLAR_RPC_URL',
        expected: 'Mainnet RPC endpoint',
        actual: rpcUrl,
        severity: 'error',
        description: `RPC URL '${rpcUrl}' contains testnet/futurenet domain but STELLAR_NETWORK is mainnet`,
      })
    } else if (envNetwork === 'testnet' && rpcUrl.includes('mainnet')) {
      drifts.push({
        component: 'network',
        field: 'STELLAR_RPC_URL',
        expected: 'Testnet RPC endpoint',
        actual: rpcUrl,
        severity: 'error',
        description: `RPC URL '${rpcUrl}' contains mainnet domain but STELLAR_NETWORK is testnet`,
      })
    } else {
      checksPassed++
    }
  }

  // 4. Vault Contract ID Metadata & Format Validation
  totalChecks++
  if (!vaultContractId) {
    drifts.push({
      component: 'contract',
      field: 'VAULT_CONTRACT_ID',
      expected: 'Valid Soroban Contract ID (56 chars, starting with C)',
      actual: 'missing',
      severity: 'error',
      description: 'VAULT_CONTRACT_ID is missing from environment metadata',
    })
  } else if (!isValidContractId(vaultContractId)) {
    drifts.push({
      component: 'contract',
      field: 'VAULT_CONTRACT_ID',
      expected: 'Valid Soroban Contract ID (56 chars, starting with C)',
      actual: vaultContractId,
      severity: 'error',
      description: `VAULT_CONTRACT_ID '${vaultContractId}' fails Soroban contract ID format validation`,
    })
  } else {
    checksPassed++
  }

  // 5. USDC Token Address Validation
  totalChecks++
  if (!usdcTokenAddress) {
    drifts.push({
      component: 'contract',
      field: 'USDC_TOKEN_ADDRESS',
      expected: 'Valid Contract ID (C...) or Account Address (G...)',
      actual: 'missing',
      severity: 'error',
      description: 'USDC_TOKEN_ADDRESS is missing from deployment metadata',
    })
  } else if (
    !isValidContractId(usdcTokenAddress) &&
    !StrKey.isValidEd25519PublicKey(usdcTokenAddress)
  ) {
    drifts.push({
      component: 'contract',
      field: 'USDC_TOKEN_ADDRESS',
      expected: 'Valid Contract ID (C...) or Account Address (G...)',
      actual: usdcTokenAddress,
      severity: 'error',
      description: `USDC_TOKEN_ADDRESS '${usdcTokenAddress}' fails Stellar address format validation`,
    })
  } else {
    checksPassed++
  }

  // 6. Agent Secret Key Format Validation
  totalChecks++
  if (!agentSecretKey) {
    drifts.push({
      component: 'secret',
      field: 'STELLAR_AGENT_SECRET_KEY',
      expected: 'Valid Stellar Secret Key (56 chars starting with S)',
      actual: 'missing',
      severity: 'error',
      description:
        'STELLAR_AGENT_SECRET_KEY is missing from environment metadata',
    })
  } else if (!StrKey.isValidEd25519SecretSeed(agentSecretKey)) {
    drifts.push({
      component: 'secret',
      field: 'STELLAR_AGENT_SECRET_KEY',
      expected: 'Valid Stellar Secret Key (56 chars starting with S)',
      actual: 'invalid_secret_key_format',
      severity: 'error',
      description:
        'STELLAR_AGENT_SECRET_KEY fails Ed25519 secret seed validation',
    })
  } else {
    checksPassed++
  }

  const hasErrors = drifts.some((d) => d.severity === 'error')

  return {
    timestamp: new Date().toISOString(),
    network: envNetwork,
    driftDetected: hasErrors,
    drifts,
    checksPassed,
    totalChecks,
  }
}

function isValidContractId(id: string): boolean {
  return Boolean(
    id && id.length === 56 && id.startsWith('C') && StrKey.isValidContract(id)
  )
}
