// #345 — pure circuit-breaker trip rules: drawdown, de-peg, oscillation and
// stale-data. All deterministic; the service layer feeds these measurements.
import {
  evaluateAbnormalLossRule,
  evaluateDepegRule,
  evaluateOscillationRule,
  evaluateStaleDataRule,
  evaluateBreakerRules,
  validateBreakerConfig,
  ValuePoint,
  BreakerRuleConfig,
} from '../../../src/agent/breakerRules'

const now = new Date('2026-09-01T12:00:00.000Z')
const HOUR = 60 * 60 * 1000

function pts(values: Array<[number, number]>): ValuePoint[] {
  return values.map(([hoursAgo, value]) => ({
    at: new Date(now.getTime() - hoursAgo * HOUR),
    value,
  }))
}

describe('breakerRules', () => {
  describe('evaluateAbnormalLossRule', () => {
    it('trips when window drawdown exceeds lossPct', () => {
      const r = evaluateAbnormalLossRule({
        series: pts([
          [0, 92],
          [2, 100],
        ]),
        lossPct: 5,
        windowHours: 24,
        now,
      })
      expect(r.tripped).toBe(true)
      expect(r.rule).toBe('abnormal_loss')
      expect(r.detail.drawdownPct).toBeCloseTo(-8)
    })

    it('does not trip at or better than the threshold', () => {
      const r = evaluateAbnormalLossRule({
        series: pts([
          [0, 100],
          [2, 92],
        ]),
        lossPct: 5,
        windowHours: 24,
        now,
      })
      expect(r.tripped).toBe(false)
    })

    it('needs at least two in-window points', () => {
      const r = evaluateAbnormalLossRule({
        series: pts([[0, 50]]),
        lossPct: 5,
        windowHours: 24,
        now,
      })
      expect(r.tripped).toBe(false)
      expect(r.detail.reason).toBe('insufficient_history')
    })

    it('ignores points outside the window', () => {
      const r = evaluateAbnormalLossRule({
        series: pts([
          [25, 200],
          [48, 200],
        ]),
        lossPct: 5,
        windowHours: 24,
        now,
      })
      expect(r.tripped).toBe(false)
      expect(r.detail.points).toBe(0)
    })

    it('fails safe on non-positive values', () => {
      const r = evaluateAbnormalLossRule({
        series: [
          { at: now, value: 0 },
          { at: new Date(now.getTime() - 2 * HOUR), value: 100 },
        ],
        lossPct: 5,
        windowHours: 24,
        now,
      })
      expect(r.tripped).toBe(false)
      expect(r.detail.reason).toBe('non_positive_peak')
    })

    it('sorts the series oldest-first regardless of input order', () => {
      const r = evaluateAbnormalLossRule({
        series: [
          { at: now, value: 880 },
          { at: new Date(now.getTime() - 4 * HOUR), value: 920 },
          { at: new Date(now.getTime() - 2 * HOUR), value: 1000 },
        ],
        lossPct: 5,
        windowHours: 24,
        now,
      })
      expect(r.tripped).toBe(true)
      expect(r.detail.peak).toBe(1000)
    })
  })

  describe('evaluateDepegRule', () => {
    it('trips when deviation exceeds depegBps', () => {
      const r = evaluateDepegRule({ price: 1.02, depegBps: 150 })
      expect(r.tripped).toBe(true)
      expect(r.detail.deviationBps).toBeCloseTo(200)
    })

    it('does not trip within the band', () => {
      expect(evaluateDepegRule({ price: 1.01, depegBps: 150 }).tripped).toBe(
        false
      )
      expect(evaluateDepegRule({ price: 0.99, depegBps: 150 }).tripped).toBe(
        false
      )
    })

    it('fails safe on a null price (no feed)', () => {
      const r = evaluateDepegRule({ price: null, depegBps: 150 })
      expect(r.tripped).toBe(false)
      expect(r.detail.reason).toBe('no_price_feed')
    })

    it('fails safe on non-finite or non-positive prices', () => {
      expect(evaluateDepegRule({ price: NaN, depegBps: 150 }).tripped).toBe(
        false
      )
      expect(
        evaluateDepegRule({ price: Infinity, depegBps: 150 }).tripped
      ).toBe(false)
      expect(evaluateDepegRule({ price: 0, depegBps: 150 }).tripped).toBe(false)
    })
  })

  describe('evaluateOscillationRule', () => {
    it('trips at maxFlips', () => {
      expect(evaluateOscillationRule({ flips: 3, maxFlips: 3 }).tripped).toBe(
        true
      )
    })

    it('does not trip below maxFlips', () => {
      expect(evaluateOscillationRule({ flips: 2, maxFlips: 3 }).tripped).toBe(
        false
      )
    })
  })

  describe('evaluateStaleDataRule', () => {
    it('trips when consecutive failures hit the threshold', () => {
      const r = evaluateStaleDataRule({
        latestFetchedAt: now,
        maxStaleMinutes: 120,
        maxConsecutiveFailures: 3,
        consecutiveFailures: 3,
        now,
      })
      expect(r.tripped).toBe(true)
      expect(r.detail.reason).toBe('consecutive_scan_failures')
    })

    it('a single failure does not trip', () => {
      const r = evaluateStaleDataRule({
        latestFetchedAt: now,
        maxStaleMinutes: 120,
        maxConsecutiveFailures: 3,
        consecutiveFailures: 1,
        now,
      })
      expect(r.tripped).toBe(false)
    })

    it('trips on never-scanned even with zero failures', () => {
      const r = evaluateStaleDataRule({
        latestFetchedAt: null,
        maxStaleMinutes: 120,
        maxConsecutiveFailures: 3,
        consecutiveFailures: 0,
        now,
      })
      expect(r.tripped).toBe(true)
      expect(r.detail.reason).toBe('never_scanned')
    })

    it('trips when the last successful fetch is older than maxStaleMinutes', () => {
      const r = evaluateStaleDataRule({
        latestFetchedAt: new Date(now.getTime() - 3 * 60 * 60 * 1000),
        maxStaleMinutes: 120,
        maxConsecutiveFailures: 3,
        consecutiveFailures: 0,
        now,
      })
      expect(r.tripped).toBe(true)
    })

    it('does not trip while the table is fresh', () => {
      const r = evaluateStaleDataRule({
        latestFetchedAt: new Date(now.getTime() - 10 * 60 * 1000),
        maxStaleMinutes: 120,
        maxConsecutiveFailures: 3,
        consecutiveFailures: 0,
        now,
      })
      expect(r.tripped).toBe(false)
    })
  })

  describe('evaluateBreakerRules', () => {
    const cfg: BreakerRuleConfig = {
      abnormalLoss: { enabled: true, lossPct: 5, windowHours: 24 },
      depeg: { enabled: true, depegBps: 150 },
      oscillation: { enabled: true, maxFlips: 3 },
      staleData: {
        enabled: true,
        maxStaleMinutes: 120,
        maxConsecutiveFailures: 3,
      },
    }

    it('returns no-trip with reason none when everything clears', () => {
      const r = evaluateBreakerRules(cfg, {
        abnormalLossSeries: pts([
          [0, 100],
          [2, 100],
        ]),
        depegPrice: 1.0,
        oscillationFlips: 1,
        latestFetchedAt: now,
        consecutiveFailures: 0,
        now,
      })
      expect(r.tripped).toBe(false)
      expect(r.detail.reason).toBe('none')
    })

    it('evaluates in order: abnormal_loss beats depeg', () => {
      const r = evaluateBreakerRules(cfg, {
        abnormalLossSeries: pts([
          [0, 80],
          [2, 100],
        ]),
        depegPrice: 1.1,
        oscillationFlips: 0,
        latestFetchedAt: now,
        consecutiveFailures: 0,
        now,
      })
      expect(r.rule).toBe('abnormal_loss')
    })

    it('skips disabled rules', () => {
      const off: BreakerRuleConfig = {
        abnormalLoss: { enabled: false, lossPct: 5, windowHours: 24 },
        depeg: { enabled: false, depegBps: 150 },
        oscillation: { enabled: false, maxFlips: 3 },
        staleData: {
          enabled: false,
          maxStaleMinutes: 120,
          maxConsecutiveFailures: 3,
        },
      }
      const r = evaluateBreakerRules(off, {
        abnormalLossSeries: pts([
          [0, 1],
          [1, 0.5],
        ]),
        depegPrice: 0.5,
        oscillationFlips: 99,
        latestFetchedAt: null,
        consecutiveFailures: 99,
        now,
      })
      expect(r.tripped).toBe(false)
    })

    it('skips abnormal_loss when no series is supplied', () => {
      const r = evaluateBreakerRules(cfg, {
        depegPrice: 1.0,
        oscillationFlips: 0,
        latestFetchedAt: now,
        consecutiveFailures: 0,
        now,
      })
      expect(r.tripped).toBe(false)
    })

    it('de-peg trips when it is the first failing rule in order', () => {
      const r = evaluateBreakerRules(cfg, {
        abnormalLossSeries: pts([
          [0, 100],
          [2, 100],
        ]),
        depegPrice: 1.02,
        oscillationFlips: 0,
        latestFetchedAt: now,
        consecutiveFailures: 0,
        now,
      })
      expect(r.rule).toBe('depeg')
    })
  })

  describe('validateBreakerConfig', () => {
    it('accepts a well-formed config', () => {
      expect(() =>
        validateBreakerConfig({
          abnormalLoss: { enabled: true, lossPct: 5, windowHours: 24 },
          depeg: { enabled: true, depegBps: 150 },
          oscillation: { enabled: true, maxFlips: 3 },
          staleData: {
            enabled: true,
            maxStaleMinutes: 120,
            maxConsecutiveFailures: 3,
          },
        })
      ).not.toThrow()
    })

    it('rejects a non-positive lossPct when enabled', () => {
      expect(() => {
        validateBreakerConfig({
          abnormalLoss: { enabled: true, lossPct: 0, windowHours: 24 },
          depeg: { enabled: false, depegBps: 150 },
          oscillation: { enabled: false, maxFlips: 3 },
          staleData: {
            enabled: false,
            maxStaleMinutes: 120,
            maxConsecutiveFailures: 3,
          },
        })
      }).toThrow(/BREAKER_LOSS_PCT/)
    })

    it('rejects maxFlips below 2 when enabled', () => {
      expect(() => {
        validateBreakerConfig({
          abnormalLoss: { enabled: false, lossPct: 5, windowHours: 24 },
          depeg: { enabled: false, depegBps: 150 },
          oscillation: { enabled: true, maxFlips: 1 },
          staleData: {
            enabled: false,
            maxStaleMinutes: 120,
            maxConsecutiveFailures: 3,
          },
        })
      }).toThrow(/BREAKER_MAX_FLIPS/)
    })

    it('allows a bad value when the rule is disabled', () => {
      expect(() =>
        validateBreakerConfig({
          abnormalLoss: { enabled: false, lossPct: 0, windowHours: 0 },
          depeg: { enabled: false, depegBps: -5 },
          oscillation: { enabled: false, maxFlips: 1 },
          staleData: {
            enabled: false,
            maxStaleMinutes: 0,
            maxConsecutiveFailures: 0,
          },
        })
      ).not.toThrow()
    })
  })
})
