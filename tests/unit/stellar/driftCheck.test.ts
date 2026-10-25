/**
 * Unit tests for Stellar Contract & Schema Drift Detection Engine (#508)
 */

import { StrKey } from '@stellar/stellar-sdk'
import { checkStellarIntegrationDrift } from '../../../src/stellar/driftCheck'

describe('Stellar Contract & Schema Drift Detection Engine (#508)', () => {
  const validContractId = StrKey.encodeContract(Buffer.alloc(32, 1))
  const validUsdcTokenAddress = StrKey.encodeContract(Buffer.alloc(32, 2))
  const validAgentSecretKey = StrKey.encodeEd25519SecretSeed(
    Buffer.alloc(32, 3)
  )

  it('passes validation when network, contract IDs, and RPC URLs are aligned', () => {
    const report = checkStellarIntegrationDrift({
      network: 'testnet',
      rpcUrl: 'https://soroban-testnet.stellar.org',
      vaultContractId: validContractId,
      usdcTokenAddress: validUsdcTokenAddress,
      agentSecretKey: validAgentSecretKey,
    })

    expect(report.driftDetected).toBe(false)
    expect(report.drifts.length).toBe(0)
    expect(report.checksPassed).toBe(report.totalChecks)
  })

  it('detects RPC URL network mismatch drift', () => {
    const report = checkStellarIntegrationDrift({
      network: 'mainnet',
      rpcUrl: 'https://soroban-testnet.stellar.org',
      vaultContractId: validContractId,
      usdcTokenAddress: validUsdcTokenAddress,
      agentSecretKey: validAgentSecretKey,
    })

    expect(report.driftDetected).toBe(true)
    expect(report.drifts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'STELLAR_RPC_URL',
          severity: 'error',
        }),
      ])
    )
  })

  it('detects invalid Soroban contract ID format drift', () => {
    const report = checkStellarIntegrationDrift({
      network: 'testnet',
      rpcUrl: 'https://soroban-testnet.stellar.org',
      vaultContractId: 'INVALID_CONTRACT_ID_FORMAT',
      usdcTokenAddress: validUsdcTokenAddress,
      agentSecretKey: validAgentSecretKey,
    })

    expect(report.driftDetected).toBe(true)
    expect(report.drifts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'VAULT_CONTRACT_ID',
          severity: 'error',
        }),
      ])
    )
  })

  it('detects missing agent secret key metadata drift', () => {
    const report = checkStellarIntegrationDrift({
      network: 'testnet',
      rpcUrl: 'https://soroban-testnet.stellar.org',
      vaultContractId: validContractId,
      usdcTokenAddress: validUsdcTokenAddress,
      agentSecretKey: '',
    })

    expect(report.driftDetected).toBe(true)
    expect(report.drifts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'STELLAR_AGENT_SECRET_KEY',
          severity: 'error',
        }),
      ])
    )
  })
})
