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
import db from '../db'
import { logger } from '../utils/logger'

type Db = typeof db | Prisma.TransactionClient

export class SignerRotationStateError extends Error {}

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
