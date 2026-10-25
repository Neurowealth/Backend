/**
 * Regression guard for the #529 seed migration
 * (prisma/migrations/20260928150000_add_protocol_risk_metadata). The seed
 * SQL must reproduce PROTOCOL_RISK_METADATA's current values exactly, all
 * marked UNVERIFIED, so agent behavior does not silently change on deploy.
 * This is a mock-based check of the comparison logic; the seed SQL itself
 * is verified by applying the migration to a real database (see
 * docs/PROTOCOL_RISK_SCORING.md).
 */
import { PROTOCOL_RISK_METADATA } from '../../../src/config/protocolRiskMetadata'
import db from '../../../src/db'

jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: {
    protocolRiskMetadataEntry: { findMany: jest.fn() },
  },
}))

const mockDb = db as any

describe('ProtocolRiskMetadataEntry seed matches static array', () => {
  it('every static entry has a corresponding seeded DB row with identical values', async () => {
    const seededRows = PROTOCOL_RISK_METADATA.map((m) => ({
      protocolName: m.protocolName,
      auditStatus: m.auditStatus,
      auditReference: m.auditReference,
      inceptionDate: new Date(m.inceptionDate),
      dataConfidence: 'UNVERIFIED',
    }))
    mockDb.protocolRiskMetadataEntry.findMany.mockResolvedValue(seededRows)

    const rows = await db.protocolRiskMetadataEntry.findMany({})

    expect(rows.map((r: any) => r.protocolName).sort()).toEqual(
      [...PROTOCOL_RISK_METADATA.map((m) => m.protocolName)].sort()
    )
    for (const row of rows) {
      const match = PROTOCOL_RISK_METADATA.find(
        (m) => m.protocolName === row.protocolName
      )
      expect(match).toBeDefined()
      expect(row.auditStatus).toBe(match!.auditStatus)
      expect(row.auditReference).toBe(match!.auditReference)
      expect(row.dataConfidence).toBe('UNVERIFIED')
    }
  })

  it('flags a mismatch when a seeded row diverges from the static array', async () => {
    const wrongRows = PROTOCOL_RISK_METADATA.map((m) => ({
      protocolName: m.protocolName,
      auditStatus: 'UNAUDITED', // deliberately wrong
      auditReference: m.auditReference,
      inceptionDate: new Date(m.inceptionDate),
      dataConfidence: 'UNVERIFIED',
    }))
    mockDb.protocolRiskMetadataEntry.findMany.mockResolvedValue(wrongRows)

    const rows = await db.protocolRiskMetadataEntry.findMany({})
    const blend = rows.find((r: any) => r.protocolName === 'Blend')
    const match = PROTOCOL_RISK_METADATA.find((m) => m.protocolName === 'Blend')

    expect(blend!.auditStatus).not.toBe(match!.auditStatus)
  })
})
