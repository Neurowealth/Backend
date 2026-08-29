/**
 * src/stellar/multisig.ts
 *
 * Multi-signature support for treasury operations.
 * Minimal implementation for #341.
 */

import { TransactionBuilder, Keypair, Networks } from '@stellar/stellar-sdk'
import { getNetworkPassphrase } from './client'
import { logger } from '../utils/logger'

// ── Types ───────────────────────────────────────────────────────────────────────

export interface MultisigEnvelope {
  id: string
  sweepId?: string
  publicKey: string
  threshold: number
  signatures: string[]
  status: 'PENDING' | 'COLLECTING' | 'READY' | 'EXPIRED'
  expiresAt: Date
}

export interface SignatureRequest {
  envelopeId: string
  publicKey: string
  signature: string
}

// ── Envelope Building ─────────────────────────────────────────────────────────────

export function buildMultisigEnvelope(
  publicKey: string,
  threshold: number,
  expiresAt: Date
): MultisigEnvelope {
  return {
    id: crypto.randomUUID(),
    publicKey,
    threshold,
    signatures: [],
    status: 'PENDING',
    expiresAt,
  }
}

// ── Signature Collection ─────────────────────────────────────────────────────────

export function addSignature(
  envelope: MultisigEnvelope,
  signature: string
): MultisigEnvelope {
  if (new Date() > envelope.expiresAt) {
    throw new Error('Envelope expired')
  }

  const updatedSignatures = [...envelope.signatures, signature]
  const status =
    updatedSignatures.length >= envelope.threshold ? 'READY' : 'COLLECTING'

  return {
    ...envelope,
    signatures: updatedSignatures,
    status,
  }
}

// ── Transaction Assembly ───────────────────────────────────────────────────────────

export function assembleTransaction(
  envelope: MultisigEnvelope,
  baseTransaction: string
): string {
  if (envelope.status !== 'READY') {
    throw new Error('Envelope not ready for submission')
  }

  // Minimal implementation - would combine signatures with transaction
  logger.info(`[Multisig] Assembling transaction for ${envelope.publicKey}`)
  return baseTransaction
}

// ── Validation ───────────────────────────────────────────────────────────────────

export function validateThreshold(
  envelope: MultisigEnvelope,
  onChainThreshold: number
): boolean {
  return envelope.threshold === onChainThreshold
}
