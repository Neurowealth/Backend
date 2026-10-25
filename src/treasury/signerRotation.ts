/**
 * Signer rotation with a dual-active window (#528).
 *
 * A rotation enters DUAL_ACTIVE the moment it is recorded: both the old and
 * new key are valid signers from that point, so a rotation can never
 * transiently reduce signing capacity below the configured threshold. An
 * envelope opened before finalize keeps validating against the signer set
 * active when it was opened (MultisigEnvelope.signerSetVersion) — finalizing
 * a rotation never invalidates an in-flight collection.
 */
import { Prisma } from '@prisma/client'
import { StrKey } from '@stellar/stellar-sdk'
import db from '../db'
import { logger } from '../utils/logger'

type Db = typeof db | Prisma.TransactionClient

export class SignerRotationStateError extends Error {}

/**
 * Raised when a key in a rotation request (or already persisted on a rotation
 * row) is not a valid Ed25519 public key. The admin route maps this to a 400 —
 * a typo must never become the treasury account's signing key (#671).
 *
 * A dedicated class (rather than a boolean) keeps the reason in one place and
 * lets callers distinguish a validation failure from a state-transition error.
 */
export class SignerRotationValidationError extends Error {
  readonly field: string

  constructor(field: string, value: unknown) {
    super(`${field} must be a valid Stellar Ed25519 public key (G...)`)
    this.name = 'SignerRotationValidationError'
    this.field = field
    // Keep `value` out of the message/stack so a malformed request body is
    // never echoed into logs verbatim.
    void value
  }
}

function assertValidPublicKey(
  field: string,
  value: unknown
): asserts value is string {
  if (typeof value !== 'string' || !StrKey.isValidEd25519PublicKey(value)) {
    throw new SignerRotationValidationError(field, value)
  }
}

export interface SignerRotationRecord {
  id: string
  status: string
  dualActiveSince: Date | null
}

export async function initiateRotation(
  treasuryAccountId: string,
  oldSignerKey: string,
  newSignerKey: string,
  initiatedBy: string,
  database: Db = db
): Promise<SignerRotationRecord> {
  // Validate before touching the database: a malformed key written here would
  // silently redirect every subsequent sweep (resolveSignerPublicKey signs
  // with whatever TreasuryAccount.publicKey holds).
  assertValidPublicKey('oldSignerKey', oldSignerKey)
  assertValidPublicKey('newSignerKey', newSignerKey)

  const rotation = await (database as typeof db).signerRotation.create({
    data: {
      treasuryAccountId,
      oldSignerKey,
      newSignerKey,
      status: 'DUAL_ACTIVE',
      dualActiveSince: new Date(),
      initiatedBy,
    },
  })

  logger.info('[SignerRotation] Rotation entered dual-active window', {
    rotationId: rotation.id,
    treasuryAccountId,
  })

  return rotation
}

export async function finalizeRotation(
  rotationId: string,
  finalizedBy: string,
  database: Db = db
): Promise<{ id: string; status: string }> {
  const existing = await (database as typeof db).signerRotation.findUnique({
    where: { id: rotationId },
  })

  if (!existing) {
    throw new SignerRotationStateError('Rotation not found')
  }
  if (existing.status !== 'DUAL_ACTIVE') {
    throw new SignerRotationStateError(
      `Cannot finalize rotation in status ${existing.status}`
    )
  }

  // Re-validate at finalize: rows created before validation existed (or by a
  // path that bypassed initiateRotation) must not be promoted to the treasury
  // account's signing key.
  assertValidPublicKey('newSignerKey', existing.newSignerKey)

  const result = await (database as typeof db).$transaction(async (tx) => {
    const finalized = await tx.signerRotation.update({
      where: { id: rotationId },
      data: { status: 'FINALIZED', finalizedAt: new Date() },
    })
    await tx.treasuryAccount.update({
      where: { id: existing.treasuryAccountId },
      data: { publicKey: existing.newSignerKey },
    })
    return finalized
  })

  logger.info('[SignerRotation] Rotation finalized', {
    rotationId,
    finalizedBy,
  })

  return result
}
