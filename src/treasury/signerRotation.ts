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
import { enqueueOutboxOp } from '../outbox/service'

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

  // Re-validate at finalize: a legacy/bad row must never be submitted as an
  // on-chain signer.
  assertValidPublicKey('newSignerKey', existing.newSignerKey)

  const result = await (database as typeof db).$transaction(async (tx) => {
    // Compare-and-set the status so two concurrent finalizes cannot both
    // enqueue a rotation for the same signing keys.
    const claimed = await tx.signerRotation.updateMany({
      where: { id: rotationId, status: 'DUAL_ACTIVE' },
      data: { status: 'FINALIZED', finalizedAt: new Date() },
    })
    if (claimed.count !== 1) {
      throw new SignerRotationStateError(
        `Cannot finalize rotation in status ${existing.status}`
      )
    }

    // A Stellar rotation changes the SIGNERS of an account, never its address.
    // The account's publicKey is deliberately left untouched so sweeps keep
    // targeting the treasury account; old/new keys remain on the rotation row.
    // The actual on-chain setOptions (add new, then remove old) goes through
    // the durable outbox, signed by the configured treasury signer keys.
    const op = await enqueueOutboxOp(tx, {
      idempotencyKey: `TREASURY_SIGNER_ROTATION:${rotationId}`,
      userId: 'SYSTEM',
      kind: 'TREASURY_SWEEP',
      actor: 'SYSTEM',
      priority: 'CRITICAL',
      payload: {
        method: 'treasury_signer_rotation',
        rotationId,
        treasuryAccountId: existing.treasuryAccountId,
        oldSignerKey: existing.oldSignerKey,
        newSignerKey: existing.newSignerKey,
        finalizedBy,
      },
    })

    logger.info('[SignerRotation] Signer update queued on-chain', {
      rotationId,
      outboxOpId: op.id,
    })
    return { id: rotationId, status: 'FINALIZED' }
  })

  logger.info('[SignerRotation] Rotation finalized', {
    rotationId,
    finalizedBy,
  })

  return result
}
