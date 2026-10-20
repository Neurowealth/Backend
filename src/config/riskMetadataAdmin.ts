/**
 * Admin CRUD for ProtocolRiskMetadataEntry (#529). sourceUrl is required for
 * any upgrade to dataConfidence: VERIFIED — a claim is only checkable if it
 * points somewhere. Every update writes an append-only
 * ProtocolRiskMetadataHistory row so a disputed status change is auditable.
 */
import { DataConfidence, AuditStatus } from '@prisma/client'
import db from '../db'
import { refreshMetadataCache } from './protocolRiskMetadata'

export class RiskMetadataValidationError extends Error {}

export interface UpdateRiskMetadataInput {
  auditStatus?: AuditStatus
  auditReference?: string
  sourceUrl?: string
  dataConfidence?: DataConfidence
  nextReviewDueAt?: Date
}

export async function updateRiskMetadata(
  protocolName: string,
  input: UpdateRiskMetadataInput,
  adminName: string
): Promise<{ protocolName: string; dataConfidence: DataConfidence }> {
  if (input.dataConfidence === 'VERIFIED' && !input.sourceUrl) {
    throw new RiskMetadataValidationError(
      'sourceUrl is required to set dataConfidence to VERIFIED'
    )
  }

  const result = await db.$transaction(async (tx) => {
    const updated = await tx.protocolRiskMetadataEntry.update({
      where: { protocolName },
      data: {
        ...input,
        reviewedAt: new Date(),
        reviewedBy: adminName,
      },
    })
    await tx.protocolRiskMetadataHistory.create({
      data: {
        entryId: updated.id,
        auditStatus: updated.auditStatus,
        dataConfidence: updated.dataConfidence,
        sourceUrl: updated.sourceUrl,
        changedBy: adminName,
      },
    })
    return updated
  })

  await refreshMetadataCache()

  return result
}

export interface UpsertRiskMetadataInput {
  auditStatus: AuditStatus
  auditReference: string
  sourceUrl?: string
  dataConfidence?: DataConfidence
  inceptionDate: Date
  nextReviewDueAt: Date
}

export interface RiskMetadataAdmin {
  id: string
  name: string
  role: string
}

/**
 * Create-or-update an entry (#621). Same VERIFIED/sourceUrl rule as
 * updateRiskMetadata; the history row and the AdminAuditLog row (with
 * before/after) commit in the same transaction as the change itself.
 */
export async function upsertRiskMetadata(
  protocolName: string,
  input: UpsertRiskMetadataInput,
  admin: RiskMetadataAdmin
) {
  if (input.dataConfidence === 'VERIFIED' && !input.sourceUrl) {
    throw new RiskMetadataValidationError(
      'sourceUrl is required to set dataConfidence to VERIFIED'
    )
  }
  if (input.nextReviewDueAt <= new Date()) {
    throw new RiskMetadataValidationError(
      'nextReviewDueAt must be in the future'
    )
  }

  const result = await db.$transaction(async (tx) => {
    const before = await tx.protocolRiskMetadataEntry.findUnique({
      where: { protocolName },
    })
    const data = { ...input, reviewedAt: new Date(), reviewedBy: admin.name }
    const entry = await tx.protocolRiskMetadataEntry.upsert({
      where: { protocolName },
      create: { protocolName, ...data },
      update: data,
    })
    await tx.protocolRiskMetadataHistory.create({
      data: {
        entryId: entry.id,
        auditStatus: entry.auditStatus,
        dataConfidence: entry.dataConfidence,
        sourceUrl: entry.sourceUrl,
        changedBy: admin.name,
      },
    })
    await tx.adminAuditLog.create({
      data: {
        adminKeyId: admin.id,
        adminName: admin.name,
        adminRole: admin.role,
        action: 'RISK_METADATA_UPSERT',
        target: protocolName,
        result: 'SUCCESS',
        details: {
          before: before && {
            auditStatus: before.auditStatus,
            dataConfidence: before.dataConfidence,
            sourceUrl: before.sourceUrl,
            nextReviewDueAt: before.nextReviewDueAt,
          },
          after: {
            auditStatus: entry.auditStatus,
            dataConfidence: entry.dataConfidence,
            sourceUrl: entry.sourceUrl,
            nextReviewDueAt: entry.nextReviewDueAt,
          },
        },
      },
    })
    return entry
  })

  await refreshMetadataCache()
  return result
}
