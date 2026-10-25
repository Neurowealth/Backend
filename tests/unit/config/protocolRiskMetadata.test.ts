import {
  getProtocolMetadata,
  refreshMetadataCache,
  invalidateMetadataCache,
} from '../../../src/config/protocolRiskMetadata'
import db from '../../../src/db'

jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: {
    protocolRiskMetadataEntry: { findMany: jest.fn() },
  },
}))

const mockDb = db as any

beforeEach(() => {
  invalidateMetadataCache()
  jest.clearAllMocks()
})

describe('getProtocolMetadata (DB-backed, sync read over a cache)', () => {
  it('returns the conservative default before any refresh has populated the cache', () => {
    const meta = getProtocolMetadata('Blend')
    expect(meta.auditStatus).toBe('UNAUDITED')
  })

  it('returns a curated entry after refreshMetadataCache populates it', async () => {
    mockDb.protocolRiskMetadataEntry.findMany.mockResolvedValue([
      {
        protocolName: 'Blend',
        auditStatus: 'THIRD_PARTY_AUDITED',
        auditReference: 'ref-1',
        inceptionDate: new Date('2024-02-01'),
      },
    ])

    await refreshMetadataCache()
    const meta = getProtocolMetadata('Blend')

    expect(meta.auditStatus).toBe('THIRD_PARTY_AUDITED')
    expect(meta.inceptionDate).toBe('2024-02-01T00:00:00.000Z')
  })

  it('returns the conservative default for a protocol with no entry, never silently safe', async () => {
    mockDb.protocolRiskMetadataEntry.findMany.mockResolvedValue([])
    await refreshMetadataCache()

    const meta = getProtocolMetadata('UnknownProtocol')

    expect(meta.auditStatus).toBe('UNAUDITED')
    expect(meta.inceptionDate).toBe('')
  })
})
