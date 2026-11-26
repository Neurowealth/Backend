/**
 * src/stellar/multisig.ts
 *
 * Multi-signature support for treasury operations.
 * Minimal implementation for #341.
 */

import {
  TransactionBuilder,
  Keypair,
  Networks,
  xdr,
} from '@stellar/stellar-sdk'
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

// ── Signature Decoding ──────────────────────────────────────────────────────────

/**
 * Decodes a signature into an xdr.DecoratedSignature.
 * Supports:
 *  - Base64-encoded XDR DecoratedSignature
 *  - JSON string with { publicKey, signature } or { hint, signature }
 *  - Colon-delimited string: "G...:signature"
 *  - Already-instantiated xdr.DecoratedSignature
 */
export function decodeDecoratedSignature(
  sig: string | xdr.DecoratedSignature
): xdr.DecoratedSignature {
  if (
    typeof sig === 'object' &&
    sig !== null &&
    'hint' in sig &&
    'signature' in sig &&
    typeof (sig as any).toXDR === 'function'
  ) {
    return sig as xdr.DecoratedSignature
  }

  if (typeof sig === 'string') {
    const trimmed = sig.trim()

    // 1. JSON representation: { publicKey, signature } or { hint, signature }
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed)
        if (parsed.publicKey && parsed.signature) {
          const kp = Keypair.fromPublicKey(parsed.publicKey)
          const hint = kp.rawPublicKey().subarray(28, 32)
          const sigBuf = Buffer.isBuffer(parsed.signature)
            ? parsed.signature
            : Buffer.from(
                parsed.signature,
                parsed.signature.length === 128 ? 'hex' : 'base64'
              )
          return new xdr.DecoratedSignature({ hint, signature: sigBuf })
        }
        if (parsed.hint && parsed.signature) {
          const hintBuf = Buffer.isBuffer(parsed.hint)
            ? parsed.hint
            : Buffer.from(parsed.hint, 'base64')
          const sigBuf = Buffer.isBuffer(parsed.signature)
            ? parsed.signature
            : Buffer.from(parsed.signature, 'base64')
          return new xdr.DecoratedSignature({
            hint: hintBuf,
            signature: sigBuf,
          })
        }
      } catch {
        // Fall through to other formats
      }
    }

    // 2. Colon-delimited representation: "G...:<base64-or-hex-sig>"
    if (trimmed.includes(':')) {
      const colonIdx = trimmed.indexOf(':')
      const pubkey = trimmed.substring(0, colonIdx)
      const sigData = trimmed.substring(colonIdx + 1)
      if (pubkey.startsWith('G') && pubkey.length === 56) {
        const kp = Keypair.fromPublicKey(pubkey)
        const hint = kp.rawPublicKey().subarray(28, 32)
        const sigBuf = Buffer.from(
          sigData,
          sigData.length === 128 ? 'hex' : 'base64'
        )
        return new xdr.DecoratedSignature({ hint, signature: sigBuf })
      }
    }

    // 3. Raw base64 XDR DecoratedSignature
    return xdr.DecoratedSignature.fromXDR(trimmed, 'base64')
  }

  throw new Error('Unsupported signature format')
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

  if (envelope.expiresAt && new Date() > envelope.expiresAt) {
    throw new Error('Envelope expired')
  }

  if (!envelope.signatures || envelope.signatures.length < envelope.threshold) {
    throw new Error(
      `Insufficient signatures: expected at least ${envelope.threshold}, got ${envelope.signatures?.length ?? 0}`
    )
  }

  logger.info(`[Multisig] Assembling transaction for ${envelope.publicKey}`)

  const networkPassphrase = getNetworkPassphrase()
  const tx = TransactionBuilder.fromXDR(baseTransaction, networkPassphrase)

  for (const rawSig of envelope.signatures) {
    const decoratedSig = decodeDecoratedSignature(rawSig)

    const alreadyExists = tx.signatures.some(
      (existing) =>
        existing.hint().equals(decoratedSig.hint()) &&
        existing.signature().equals(decoratedSig.signature())
    )
    if (!alreadyExists) {
      tx.signatures.push(decoratedSig)
    }
  }

  return tx.toXDR()
}

// ── Validation ───────────────────────────────────────────────────────────────────

export function validateThreshold(
  envelope: MultisigEnvelope,
  onChainThreshold: number
): boolean {
  return envelope.threshold === onChainThreshold
}
