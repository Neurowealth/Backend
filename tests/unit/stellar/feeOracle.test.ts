import {
  deriveCongestionLevel,
  isStale,
  getFeeSnapshot,
  __setSnapshotForTest,
  __resetForTest,
  FeeSnapshot,
} from '../../../src/stellar/feeOracle'

jest.mock('../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

jest.mock('../../../src/services/alerting', () => ({
  alertingService: { emit: jest.fn().mockResolvedValue(undefined) },
}))

jest.mock('../../../src/config/redis', () => ({
  cacheGet: jest.fn().mockResolvedValue(null),
  cacheSet: jest.fn().mockResolvedValue(undefined),
}))

describe('feeOracle helpers', () => {
  afterEach(() => __resetForTest())

  it('deriveCongestionLevel rises immediately', () => {
    expect(deriveCongestionLevel(0.9, 100, 400, 'low', true)).toBe('severe')
    expect(deriveCongestionLevel(0.6, 100, 150, 'low', true)).toBe('elevated')
  })

  it('does not flap without dwell', () => {
    // high capacity suggests severe, but dwell not ok -> stays low
    expect(deriveCongestionLevel(0.9, 100, 400, 'low', false)).toBe('low')
    // with dwell ok, it moves
    expect(deriveCongestionLevel(0.9, 100, 400, 'low', true)).toBe('severe')
  })

  it('fee spread drives level', () => {
    expect(deriveCongestionLevel(0.2, 100, 400, 'low', true)).toBe('severe')
    expect(deriveCongestionLevel(0.2, 100, 120, 'low', true)).toBe('low')
  })

  it('isStale respects TTL with grace', () => {
    const snap: FeeSnapshot = {
      recommendedBaseFee: 100,
      aggressiveBaseFee: 100,
      congestionLevel: 'low',
      ledgerCapacityUsage: 0,
      sampledAt: new Date(Date.now() - 10000).toISOString(),
      ttlMs: 30000,
    }
    expect(isStale(snap)).toBe(false)
    const old: FeeSnapshot = {
      ...snap,
      sampledAt: new Date(Date.now() - 40000).toISOString(),
    }
    expect(isStale(old)).toBe(true)
  })

  it('getFeeSnapshot falls back to default on cold start or stale', () => {
    __resetForTest()
    const s = getFeeSnapshot()
    expect(s.recommendedBaseFee).toBe(100)
    expect(s.congestionLevel).toBe('low')

    const stale: FeeSnapshot = {
      recommendedBaseFee: 500,
      aggressiveBaseFee: 1000,
      congestionLevel: 'high',
      ledgerCapacityUsage: 0.8,
      sampledAt: new Date(Date.now() - 100000).toISOString(),
      ttlMs: 30000,
    }
    __setSnapshotForTest(stale)
    const fallback = getFeeSnapshot()
    expect(fallback.congestionLevel).toBe('low')
    expect(fallback.recommendedBaseFee).toBe(100)
  })

  it('__setSnapshotForTest publishes snapshot', () => {
    const snap: FeeSnapshot = {
      recommendedBaseFee: 250,
      aggressiveBaseFee: 600,
      congestionLevel: 'high',
      ledgerCapacityUsage: 0.75,
      sampledAt: new Date().toISOString(),
      ttlMs: 30000,
    }
    __setSnapshotForTest(snap)
    const got = getFeeSnapshot()
    expect(got.recommendedBaseFee).toBe(250)
    expect(got.aggressiveBaseFee).toBe(600)
    expect(got.congestionLevel).toBe('high')
  })
})
