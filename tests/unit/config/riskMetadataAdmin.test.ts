import {
  updateRiskMetadata,
  upsertRiskMetadata,
  RiskMetadataValidationError,
} from '../../../src/config/riskMetadataAdmin'
import db from '../../../src/db'

jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(),
  },
}))
jest.mock('../../../src/config/protocolRiskMetadata', () => ({
  refreshMetadataCache: jest.fn().mockResolvedValue(undefined),
}))

const mockDb = db as any

beforeEach(() => {
  jest.clearAllMocks()
})

describe('updateRiskMetadata', () => {
  it('requires sourceUrl to set dataConfidence to VERIFIED', async () => {
    await expect(
      updateRiskMetadata('Blend', { dataConfidence: 'VERIFIED' }, 'admin-1')
    ).rejects.toThrow(RiskMetadataValidationError)
  })

  it('accepts VERIFIED with a sourceUrl and writes a history row', async () => {
    mockDb.$transaction.mockImplementation(async (fn: any) =>
      fn({
        protocolRiskMetadataEntry: {
          update: jest.fn().mockResolvedValue({
            id: 'entry-1',
            protocolName: 'Blend',
            dataConfidence: 'VERIFIED',
            auditStatus: 'THIRD_PARTY_AUDITED',
            sourceUrl: 'https://audits.example/blend',
          }),
        },
        protocolRiskMetadataHistory: { create: jest.fn() },
      })
    )

    const result = await updateRiskMetadata(
      'Blend',
      { dataConfidence: 'VERIFIED', sourceUrl: 'https://audits.example/blend' },
      'admin-1'
    )

    expect(result.dataConfidence).toBe('VERIFIED')
  })

  it('allows a non-VERIFIED update without a sourceUrl', async () => {
    mockDb.$transaction.mockImplementation(async (fn: any) =>
      fn({
        protocolRiskMetadataEntry: {
          update: jest.fn().mockResolvedValue({
            id: 'entry-1',
            protocolName: 'Luma',
            dataConfidence: 'SELF_REPORTED',
          }),
        },
        protocolRiskMetadataHistory: { create: jest.fn() },
      })
    )

    await expect(
      updateRiskMetadata('Luma', { dataConfidence: 'SELF_REPORTED' }, 'admin-1')
    ).resolves.toMatchObject({ dataConfidence: 'SELF_REPORTED' })
  })
})

describe('upsertRiskMetadata (#621)', () => {
  const admin = { id: 'k1', name: 'ops', role: 'super' }
  const input = {
    auditStatus: 'THIRD_PARTY_AUDITED' as const,
    auditReference: 'https://example.com/audit.pdf',
    sourceUrl: 'https://example.com/audit.pdf',
    dataConfidence: 'VERIFIED' as const,
    inceptionDate: new Date('2024-02-01'),
    nextReviewDueAt: new Date(Date.now() + 86400000),
  }

  it('rejects VERIFIED without sourceUrl', async () => {
    await expect(
      upsertRiskMetadata('Blend', { ...input, sourceUrl: undefined }, admin)
    ).rejects.toThrow(RiskMetadataValidationError)
    expect(mockDb.$transaction).not.toHaveBeenCalled()
  })

  it('rejects a nextReviewDueAt in the past', async () => {
    await expect(
      upsertRiskMetadata(
        'Blend',
        { ...input, nextReviewDueAt: new Date('2020-01-01') },
        admin
      )
    ).rejects.toThrow('nextReviewDueAt')
  })

  it('writes the entry, history row and audit row with before/after', async () => {
    const tx = {
      protocolRiskMetadataEntry: {
        findUnique: jest.fn().mockResolvedValue({
          auditStatus: 'UNAUDITED',
          dataConfidence: 'UNVERIFIED',
          sourceUrl: null,
          nextReviewDueAt: new Date('2026-01-01'),
        }),
        upsert: jest.fn().mockResolvedValue({ id: 'e1', ...input }),
      },
      protocolRiskMetadataHistory: { create: jest.fn() },
      adminAuditLog: { create: jest.fn() },
    }
    mockDb.$transaction.mockImplementation((fn: any) => fn(tx))

    await upsertRiskMetadata('Blend', input, admin)

    expect(tx.protocolRiskMetadataHistory.create).toHaveBeenCalledTimes(1)
    expect(tx.adminAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        adminKeyId: 'k1',
        action: 'RISK_METADATA_UPSERT',
        target: 'Blend',
        details: {
          before: expect.objectContaining({ auditStatus: 'UNAUDITED' }),
          after: expect.objectContaining({ dataConfidence: 'VERIFIED' }),
        },
      }),
    })
  })
})
