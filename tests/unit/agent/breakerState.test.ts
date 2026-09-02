// #345 — pure circuit-breaker state machine: CLOSED / OPEN / HALF_OPEN
// transitions, cooldown backoff, manual trip/reset, and the describe summary.
import {
  applyBreakerEvaluation,
  applyManualTrip,
  applyManualReset,
  describeBreaker,
  BreakerRecord,
  BreakerTransitionConfig,
} from '../../../src/agent/breakerState'

const cfg: BreakerTransitionConfig = {
  cooldownMs: 60 * 60 * 1000,
  maxCooldownMs: 4 * 60 * 60 * 1000,
  sustainedClearChecks: 3,
}

const closed: BreakerRecord = {
  state: 'CLOSED',
  trippedRule: null,
  detail: null,
  trippedAt: null,
  autoResetAt: null,
}

const trip = {
  tripped: true,
  rule: 'abnormal_loss' as const,
  detail: { drawdownPct: -7 },
}

const clean = {
  tripped: false,
  rule: 'stale_data' as const,
  detail: { reason: 'none' },
}

function at(minutesAhead: number): Date {
  return new Date(Date.UTC(2026, 8, 1, 12, 0, 0) + minutesAhead * 60 * 1000)
}

function detailOf(r: BreakerRecord): Record<string, any> {
  return r.detail as Record<string, any>
}

describe('breakerState', () => {
  describe('CLOSED', () => {
    it('a clean evaluation leaves it closed', () => {
      const r = applyBreakerEvaluation(closed, clean, at(0), cfg)
      expect(r.state).toBe('CLOSED')
      expect(r).toBe(closed)
    })

    it('a trip opens it with the base cooldown', () => {
      const t0 = at(0)
      const r = applyBreakerEvaluation(closed, trip, t0, cfg)
      expect(r.state).toBe('OPEN')
      expect(r.trippedRule).toBe('abnormal_loss')
      expect(r.trippedAt?.getTime()).toBe(t0.getTime())
      expect(r.autoResetAt?.getTime()).toBe(t0.getTime() + cfg.cooldownMs)
      expect(detailOf(r)._machine).toEqual({
        clearCount: 0,
        cooldownMs: cfg.cooldownMs,
      })
    })
  })

  describe('OPEN', () => {
    const openAt = at(0)
    const open: BreakerRecord = applyBreakerEvaluation(
      closed,
      trip,
      openAt,
      cfg
    )

    it('stays OPEN on a trip and records the failed evaluation', () => {
      const later = at(5)
      const r = applyBreakerEvaluation(open, trip, later, cfg)
      expect(r.state).toBe('OPEN')
      expect(r.autoResetAt?.getTime()).toBe(openAt.getTime() + cfg.cooldownMs)
      expect(detailOf(r).lastEvaluation.rule).toBe('abnormal_loss')
      expect(detailOf(r).lastEvaluation.at).toBe(later.toISOString())
    })

    it('stays OPEN while the cooldown has not elapsed', () => {
      const r = applyBreakerEvaluation(open, clean, at(5), cfg)
      expect(r.state).toBe('OPEN')
      expect(detailOf(r)._machine.clearCount).toBe(1)
    })

    it('stays OPEN before sustainedClearChecks clean evaluations', () => {
      const beforeCooldown = at(cfg.cooldownMs / 60000 - 10)
      let r = open
      for (let i = 0; i < cfg.sustainedClearChecks; i++) {
        r = applyBreakerEvaluation(
          r,
          clean,
          new Date(beforeCooldown.getTime() + i * 3 * 60000),
          cfg
        )
      }
      expect(r.state).toBe('OPEN')
      expect(detailOf(r)._machine.clearCount).toBe(cfg.sustainedClearChecks)
    })

    it('opens to HALF_OPEN once cooldown elapsed and clears are sustained', () => {
      const afterCooldown = at(cfg.cooldownMs / 60000 + 1)
      let r = open
      for (let i = 1; i <= cfg.sustainedClearChecks; i++) {
        r = applyBreakerEvaluation(
          r,
          clean,
          new Date(afterCooldown.getTime() + i * 60000),
          cfg
        )
      }
      expect(r.state).toBe('HALF_OPEN')
      expect(detailOf(r)._machine.clearCount).toBe(cfg.sustainedClearChecks)
    })
  })

  describe('HALF_OPEN', () => {
    function toHalfOpen(t: Date): BreakerRecord {
      let r = applyBreakerEvaluation(closed, trip, t, cfg)
      // Fast-forward past cooldown with sustained clean checks.
      for (let i = 1; i <= cfg.sustainedClearChecks; i++) {
        r = applyBreakerEvaluation(
          r,
          clean,
          new Date(t.getTime() + cfg.cooldownMs + i * 60000),
          cfg
        )
      }
      expect(r.state).toBe('HALF_OPEN')
      return r
    }

    it('a clean probe closes the breaker', () => {
      const r = applyBreakerEvaluation(toHalfOpen(at(0)), clean, at(80), cfg)
      expect(r.state).toBe('CLOSED')
      expect(r.trippedRule).toBeNull()
      expect(r.trippedAt).toBeNull()
      expect(r.autoResetAt).toBeNull()
      expect(detailOf(r)._machine).toEqual({
        clearCount: 0,
        cooldownMs: cfg.cooldownMs,
      })
    })

    it('a failed probe re-opens with doubled cooldown', () => {
      const t0 = at(0)
      const half = toHalfOpen(t0)
      const probeAt = at(80)
      const r = applyBreakerEvaluation(half, trip, probeAt, cfg)
      expect(r.state).toBe('OPEN')
      expect(detailOf(r)._machine.cooldownMs).toBe(cfg.cooldownMs * 2)
      expect(r.autoResetAt?.getTime()).toBe(
        probeAt.getTime() + cfg.cooldownMs * 2
      )
    })

    it('cooldown doubling is capped at maxCooldownMs', () => {
      let r: BreakerRecord = { ...closed }
      const t0 = at(0)
      let t = new Date(t0.getTime())
      for (let i = 0; i < 6; i++) {
        r = applyBreakerEvaluation(r, trip, t, cfg)
        expect(r.state).toBe('OPEN')
        // Advance past the (possibly backed-off) cooldown, then sustain.
        const cooldown = detailOf(r)._machine.cooldownMs
        t = new Date(t.getTime() + cooldown)
        for (let j = 1; j <= cfg.sustainedClearChecks; j++) {
          r = applyBreakerEvaluation(
            r,
            clean,
            new Date(t.getTime() + j * 60000),
            cfg
          )
        }
        expect(r.state).toBe('HALF_OPEN')
        t = new Date(t.getTime() + (cfg.sustainedClearChecks + 1) * 60000)
      }
      expect(detailOf(r)._machine.cooldownMs).toBe(cfg.maxCooldownMs)
    })
  })

  describe('applyManualTrip', () => {
    it('opens a closed breaker with rule manual', () => {
      const r = applyManualTrip(closed, at(0), cfg)
      expect(r.state).toBe('OPEN')
      expect(r.trippedRule).toBe('manual')
      expect(r.autoResetAt?.getTime()).toBe(at(0).getTime() + cfg.cooldownMs)
    })

    it('is a no-op when already manually open', () => {
      const t = at(0)
      const manual = applyManualTrip(closed, t, cfg)
      const again = applyManualTrip(manual, at(1), cfg)
      expect(again).toBe(manual)
    })

    it('overrides a rule trip with manual', () => {
      const r = applyManualTrip(
        applyBreakerEvaluation(closed, trip, at(0), cfg),
        at(1),
        cfg
      )
      expect(r.trippedRule).toBe('manual')
    })
  })

  describe('applyManualReset', () => {
    it('closes any state and clears trip fields', () => {
      const opened = applyBreakerEvaluation(closed, trip, at(0), cfg)
      const r = applyManualReset(
        opened,
        at(5),
        'Nadia (super)',
        'market recovered'
      )
      expect(r.state).toBe('CLOSED')
      expect(r.trippedRule).toBeNull()
      expect(r.trippedAt).toBeNull()
      expect(r.autoResetAt).toBeNull()
      expect(detailOf(r)._lastReset).toMatchObject({
        resetBy: 'Nadia (super)',
        reason: 'market recovered',
      })
      expect(detailOf(r).rule).toBeDefined()
    })
  })

  describe('describeBreaker', () => {
    it('reports state, cooldown and clear count', () => {
      const opened = applyBreakerEvaluation(closed, trip, at(0), cfg)
      const d = describeBreaker(opened)
      expect(d.state).toBe('OPEN')
      expect(d.trippedRule).toBe('abnormal_loss')
      expect(d.cooldownMs).toBe(cfg.cooldownMs)
      expect(d.clearCount).toBe(0)
      expect(d.autoResetAt).toBe(opened.autoResetAt?.toISOString())
    })

    it('survives a missing machine section', () => {
      const d = describeBreaker(applyManualReset(closed, at(0), 'a', 'r'))
      expect(d.state).toBe('CLOSED')
      expect(d.cooldownMs).toBe(0)
      expect(d.clearCount).toBe(0)
    })
  })
})
