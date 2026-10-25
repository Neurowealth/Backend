/**
 * Regression guard: computeProtocolRiskScores' protocol-name union must
 * include everything curated in ProtocolRiskMetadataEntry (#529), not just
 * a frozen historical snapshot — a newly-curated-but-not-yet-scanned
 * protocol would otherwise never be scored.
 */
import { computeProtocolRiskScores } from '../../../src/jobs/protocolRiskScoring'
import db from '../../../src/db'

jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: {
    protocolRate: { findMany: jest.fn().mockResolvedValue([]) },
    protocolRiskMetadataEntry: { findMany: jest.fn() },
    protocolRiskScore: { upsert: jest.fn() },
  },
}))
jest.mock('../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  logBackgroundJob: jest.fn(),
}))
jest.mock('../../../src/utils/correlation', () => ({
  generateCorrelationId: jest.fn(() => 'corr-1'),
  runWithCorrelationIdAsync: jest.fn((_id: string, fn: () => Promise<void>) =>
    fn()
  ),
}))
jest.mock('../../../src/utils/job-metrics', () => ({
  recordJobSuccess: jest.fn(),
  recordJobFailure: jest.fn(),
}))

const mockDb = db as any

beforeEach(() => {
  jest.clearAllMocks()
  mockDb.protocolRate.findMany.mockResolvedValue([])
})

describe('computeProtocolRiskScores', () => {
  it('scores a protocol present only in ProtocolRiskMetadataEntry, not rate history', async () => {
    mockDb.protocolRiskMetadataEntry.findMany.mockResolvedValue([
      { protocolName: 'NewlyOnboardedProtocol' },
    ])
    mockDb.protocolRiskScore.upsert.mockResolvedValue({})

    await computeProtocolRiskScores(new Date('2026-01-01'))

    expect(mockDb.protocolRiskScore.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { protocolName: 'NewlyOnboardedProtocol' },
      })
    )
  })
})
