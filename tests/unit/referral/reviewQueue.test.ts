import {
  buildQueueWhere,
  bulkReviewConversions,
  scoreDistribution,
  suggestReviewThreshold,
  buildCalibrationReport,
} from '../../../src/referral/reviewQueue'
import db from '../../../src/db'

jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(),
    referralConversion: { findMany: jest.fn() },
  },
}))
jest.mock('../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))
jest.mock('../../../src/config', () => ({
  config: { referral: { fraud: { reviewScore: 80, targetPrecision: 0.7 } } },
}))

const mockDb = db as any

beforeEach(() => jest.clearAllMocks())

describe('buildQueueWhere', () => {
  it('combines score band, flag and date filters for pending items', () => {
    const from = new Date('2026-10-01')
    const to = new Date('2026-11-01')
    const where = buildQueueWhere({
      state: 'pending',
      scoreMin: 80,
      scoreMax: 99,
      flag: 'SAME_IP_ADDRESS',
      from,
      to,
    })
    expect(where.AND).toEqual(
      expect.arrayContaining([
        { manualReviewRequired: true, manualReviewRejected: false },
        { fraudCheckScore: { gte: 80 } },
        { fraudCheckScore: { lte: 99 } },
        { fraudCheckFlags: { has: 'SAME_IP_ADDRESS' } },
        { createdAt: { gte: from } },
        { createdAt: { lt: to } },
      ])
    )
  })
})

describe('bulkReviewConversions', () => {
  const admin = { id: 'k1', name: 'ops', role: 'write' }

  it('decides each pending conversion with an audit row and skips the rest', async () => {
    const rows: Record<string, any> = {
      a: {
        id: 'a',
        manualReviewRequired: true,
        manualReviewRejected: false,
        fraudCheckScore: 85,
        fraudCheckFlags: ['SAME_IP_ADDRESS'],
      },
      b: { id: 'b', manualReviewRequired: false, manualReviewRejected: false },
    }
    const tx = {
      referralConversion: {
        findUnique: jest.fn(({ where }: any) =>
          Promise.resolve(rows[where.id] ?? null)
        ),
        update: jest.fn(),
      },
      adminAuditLog: { create: jest.fn() },
    }
    mockDb.$transaction.mockImplementation((fn: any) => fn(tx))

    const result = await bulkReviewConversions(
      ['a', 'b', 'zzz', 'a'],
      'reject',
      admin,
      'ring'
    )

    expect(result.succeeded).toEqual(['a'])
    expect(result.skipped).toEqual([
      { id: 'b', reason: 'not pending review' },
      { id: 'zzz', reason: 'not found' },
    ])
    expect(tx.referralConversion.update).toHaveBeenCalledTimes(1)
    expect(tx.referralConversion.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          manualReviewRejected: true,
          rejectionReason: 'ring',
          reviewDecision: 'rejected',
        }),
      })
    )
    expect(tx.adminAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'REFERRAL_BULK_REJECT',
        target: 'a',
        adminKeyId: 'k1',
      }),
    })
  })
})

describe('calibration', () => {
  it('buckets scores into 20-point bands', () => {
    expect(scoreDistribution([0, 10, 45, 85, 99, 100])).toEqual([
      { band: '0-19', count: 2 },
      { band: '40-59', count: 1 },
      { band: '80-99', count: 2 },
      { band: '100-119', count: 1 },
    ])
  })

  it('suggests the lowest threshold that reaches the target precision', () => {
    const reviews = [
      { score: 80, rejected: false },
      { score: 80, rejected: false },
      { score: 90, rejected: true },
      { score: 100, rejected: true },
    ]
    expect(suggestReviewThreshold(reviews, 0.7)).toBe(90)
    expect(
      suggestReviewThreshold([{ score: 80, rejected: false }], 0.7)
    ).toBeNull()
  })

  it('computes the false-positive rate and a config-named suggestion', async () => {
    mockDb.referralConversion.findMany
      .mockResolvedValueOnce([
        { fraudCheckScore: 85 },
        { fraudCheckScore: 90 },
        { fraudCheckScore: 100 },
      ])
      .mockResolvedValueOnce([
        { fraudCheckScore: 80, manualReviewRejected: false },
        { fraudCheckScore: 82, manualReviewRejected: false },
        { fraudCheckScore: 95, manualReviewRejected: true },
        { fraudCheckScore: 100, manualReviewRejected: true },
      ])

    const report = await buildCalibrationReport('2026-10')

    expect(report).toMatchObject({
      scored: 3,
      reviewed: 4,
      approvedCount: 2,
      rejectedCount: 2,
      falsePositiveRate: 0.5,
      suggestedReviewScore: 95,
    })
    expect(report.suggestion).toContain('REFERRAL_FRAUD_REVIEW_SCORE')
  })

  it('rejects a malformed month', async () => {
    await expect(buildCalibrationReport('2026-13x')).rejects.toThrow('YYYY-MM')
  })
})
