import {
  flagStaleEntries,
  applyStalenessPenalty,
} from '../../../src/jobs/riskMetadataStaleness'
import db from '../../../src/db'
import { alertingService } from '../../../src/services/alerting'

jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: {
    protocolRiskMetadataEntry: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
  },
}))
jest.mock('../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))
jest.mock('../../../src/config/env', () => ({
  config: {
    protocolRisk: {
      staleAutoDowngrade: false,
      stalePenalty: 20,
      stalenessIntervalMs: 3600000,
    },
  },
}))
jest.mock('../../../src/services/alerting', () => ({
  alertingService: { emit: jest.fn().mockResolvedValue({ sent: true }) },
}))

const mockDb = db as any

beforeEach(() => {
  jest.clearAllMocks()
})

describe('flagStaleEntries', () => {
  it('returns protocol names past nextReviewDueAt', async () => {
    mockDb.protocolRiskMetadataEntry.findMany.mockResolvedValue([
      {
        id: 'e1',
        protocolName: 'Blend',
        nextReviewDueAt: new Date('2020-01-01'),
      },
    ])

    const stale = await flagStaleEntries(new Date('2026-01-01'))

    expect(stale).toEqual(['Blend'])
    expect(alertingService.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'critical',
        component: 'protocol-risk-metadata',
        metadata: { protocols: ['Blend'] },
      }),
      'risk-metadata-stale'
    )
    expect(alertingService.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'critical',
        component: 'protocol-risk-metadata',
        metadata: { protocols: ['Blend'] },
      }),
      'risk-metadata-stale'
    )
    expect(mockDb.protocolRiskMetadataEntry.updateMany).not.toHaveBeenCalled()
  })

  it('returns an empty array when nothing is stale', async () => {
    mockDb.protocolRiskMetadataEntry.findMany.mockResolvedValue([])

    const stale = await flagStaleEntries(new Date('2026-01-01'))

    expect(stale).toEqual([])
    expect(alertingService.emit).not.toHaveBeenCalled()
  })
})

describe('applyStalenessPenalty', () => {
  it('lowers a stale score by the configured penalty, floored at 0', () => {
    expect(applyStalenessPenalty(70, true)).toBe(50)
    expect(applyStalenessPenalty(10, true)).toBe(0)
  })

  it('leaves a fresh score untouched', () => {
    expect(applyStalenessPenalty(70, false)).toBe(70)
  })
})
