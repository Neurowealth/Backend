import {
  compare,
  isCooldownActive,
  cooldownCutoff,
  computeDrawdownPercent,
  rollingPeak,
  evaluateRule,
  type EvaluatableRule,
} from '../../../src/services/alertEvaluator';

describe('alertEvaluator', () => {
  describe('compare', () => {
    it('evaluates LT (strictly below)', () => {
      expect(compare('LT', 4.9, 5)).toBe(true);
      expect(compare('LT', 5, 5)).toBe(false);
      expect(compare('LT', 5.1, 5)).toBe(false);
    });

    it('evaluates LTE (at or below)', () => {
      expect(compare('LTE', 5, 5)).toBe(true);
      expect(compare('LTE', 4.9, 5)).toBe(true);
      expect(compare('LTE', 5.1, 5)).toBe(false);
    });

    it('evaluates GT (strictly above)', () => {
      expect(compare('GT', 5.1, 5)).toBe(true);
      expect(compare('GT', 5, 5)).toBe(false);
    });

    it('evaluates GTE (at or above)', () => {
      expect(compare('GTE', 5, 5)).toBe(true);
      expect(compare('GTE', 5.1, 5)).toBe(true);
      expect(compare('GTE', 4.9, 5)).toBe(false);
    });
  });

  describe('isCooldownActive', () => {
    const now = new Date('2026-07-20T12:00:00.000Z');

    it('is never active for a rule that has never fired', () => {
      expect(isCooldownActive(null, 60, now)).toBe(false);
      expect(isCooldownActive(undefined, 60, now)).toBe(false);
    });

    it('is active while inside the cooldown window', () => {
      const firedAt = new Date(now.getTime() - 30 * 60_000); // 30 min ago
      expect(isCooldownActive(firedAt, 60, now)).toBe(true);
    });

    it('is inactive exactly at the cooldown boundary (re-fire allowed)', () => {
      const firedAt = new Date(now.getTime() - 60 * 60_000); // exactly 60 min ago
      expect(isCooldownActive(firedAt, 60, now)).toBe(false);
    });

    it('is inactive once the cooldown has elapsed', () => {
      const firedAt = new Date(now.getTime() - 61 * 60_000);
      expect(isCooldownActive(firedAt, 60, now)).toBe(false);
    });
  });

  describe('cooldownCutoff', () => {
    it('returns the instant cooldownMinutes before now', () => {
      const now = new Date('2026-07-20T12:00:00.000Z');
      const cutoff = cooldownCutoff(60, now);
      expect(cutoff.toISOString()).toBe('2026-07-20T11:00:00.000Z');
    });
  });

  describe('computeDrawdownPercent', () => {
    it('computes decline from peak as a percentage', () => {
      expect(computeDrawdownPercent(100, 90)).toBeCloseTo(10);
      expect(computeDrawdownPercent(200, 150)).toBeCloseTo(25);
    });

    it('clamps to 0 when at or above the peak', () => {
      expect(computeDrawdownPercent(100, 100)).toBe(0);
      expect(computeDrawdownPercent(100, 120)).toBe(0);
    });

    it('returns 0 when there is no meaningful peak', () => {
      expect(computeDrawdownPercent(0, 0)).toBe(0);
      expect(computeDrawdownPercent(-5, 10)).toBe(0);
    });
  });

  describe('rollingPeak', () => {
    it('takes the max of history and the current value', () => {
      expect(rollingPeak([100, 120, 90], 110)).toBe(120);
    });

    it('treats a new high as its own peak', () => {
      expect(rollingPeak([100, 120], 150)).toBe(150);
    });

    it('handles an empty history', () => {
      expect(rollingPeak([], 80)).toBe(80);
    });
  });

  describe('evaluateRule', () => {
    const now = new Date('2026-07-20T12:00:00.000Z');
    const base: EvaluatableRule = {
      metric: 'PROTOCOL_APY',
      comparator: 'LT',
      threshold: 5,
      cooldownMinutes: 60,
      lastFiredAt: null,
    };

    it('fires when the condition is met and never fired before', () => {
      const result = evaluateRule(base, 4.5, now);
      expect(result.conditionMet).toBe(true);
      expect(result.shouldFire).toBe(true);
    });

    it('does not fire when the condition is not met', () => {
      const result = evaluateRule(base, 6, now);
      expect(result.conditionMet).toBe(false);
      expect(result.shouldFire).toBe(false);
    });

    it('suppresses a repeat fire while the condition stays true inside cooldown', () => {
      const rule: EvaluatableRule = {
        ...base,
        lastFiredAt: new Date(now.getTime() - 10 * 60_000), // 10 min ago
      };
      const result = evaluateRule(rule, 4.5, now);
      expect(result.conditionMet).toBe(true); // still true...
      expect(result.shouldFire).toBe(false); // ...but suppressed by cooldown
    });

    it('re-fires once the cooldown elapses if the condition is still true', () => {
      const rule: EvaluatableRule = {
        ...base,
        lastFiredAt: new Date(now.getTime() - 61 * 60_000), // cooldown passed
      };
      const result = evaluateRule(rule, 4.5, now);
      expect(result.shouldFire).toBe(true);
    });
  });
});
