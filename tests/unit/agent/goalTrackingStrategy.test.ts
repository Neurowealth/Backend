import {
  GoalTrackingStrategy,
  calculateRequiredApy,
  calculateYearsRemaining,
  NO_ELIGIBLE_PROTOCOLS_REASON,
} from '../../../src/agent/strategies';
import { StrategyParams, YieldProtocol } from '../../../src/agent/types';

jest.mock('../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

function makeProtocol(overrides: Partial<YieldProtocol> = {}): YieldProtocol {
  return {
    name: 'TestProtocol',
    apy: 5.0,
    assetSymbol: 'USDC',
    lastUpdated: new Date(),
    isAvailable: true,
    ...overrides,
  };
}

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

const defaultThresholds = {
  minimumImprovement: 0.5,
  maxGasPercent: 0.1,
};

function baseParams(overrides: Partial<StrategyParams> = {}): StrategyParams {
  return {
    currentProtocol: 'Blend',
    totalAmount: '10000000000000000000000',
    currentApy: 3.0,
    availableProtocols: [makeProtocol({ name: 'Blend', apy: 3.0 })],
    thresholds: defaultThresholds,
    userStrategyPreferences: [],
    ...overrides,
  };
}

describe('calculateRequiredApy', () => {
  it('computes the simple annualized rate needed to close the gap', () => {
    // (1500 - 1000) / 1000 / 1 year = 50%
    expect(calculateRequiredApy(1000, 1500, 1)).toBeCloseTo(50, 5);
  });

  it('returns 0 when the target is already met or exceeded', () => {
    expect(calculateRequiredApy(1000, 1000, 1)).toBe(0);
    expect(calculateRequiredApy(1500, 1000, 1)).toBe(0);
  });

  it('returns Infinity when there is no time left and the target is unmet', () => {
    expect(calculateRequiredApy(1000, 1500, 0)).toBe(Infinity);
    expect(calculateRequiredApy(1000, 1500, -0.1)).toBe(Infinity);
  });
});

describe('calculateYearsRemaining', () => {
  it('is positive for a future date and negative for a past date', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    expect(calculateYearsRemaining(new Date('2027-01-01T00:00:00Z'), from)).toBeGreaterThan(0.9);
    expect(calculateYearsRemaining(new Date('2025-01-01T00:00:00Z'), from)).toBeLessThan(0);
  });
});

describe('GoalTrackingStrategy', () => {
  const strategy = new GoalTrackingStrategy();

  it('returns strategy name as GOAL_TRACKING', () => {
    expect(strategy.name).toBe('GOAL_TRACKING');
  });

  it('does nothing when no goal is configured', async () => {
    const decision = await strategy.analyze(baseParams({ goal: undefined }));
    expect(decision.shouldRebalance).toBe(false);
    expect(decision.reasoning).toContain('No active savings goal');
  });

  it('reports already achieved when targetAmount <= startingAmount', async () => {
    const params = baseParams({
      goal: { targetAmount: 1000, startingAmount: 1500, targetDate: daysFromNow(180) },
    });
    const decision = await strategy.analyze(params);
    expect(decision.shouldRebalance).toBe(false);
    expect(decision.reasoning).toContain('already achieved');
  });

  it('reports a missed goal when the target date has passed without being met', async () => {
    const params = baseParams({
      goal: { targetAmount: 2000, startingAmount: 1000, targetDate: daysFromNow(-10) },
    });
    const decision = await strategy.analyze(params);
    expect(decision.shouldRebalance).toBe(false);
    expect(decision.reasoning).toContain('target date has passed');
  });

  it('on-track: does not rebalance when current APY already meets the required rate', async () => {
    // Required: (11000-10000)/10000/1 = 10%. Current APY of 12% already covers it.
    const params = baseParams({
      currentApy: 12,
      availableProtocols: [makeProtocol({ name: 'Blend', apy: 12 })],
      goal: { targetAmount: 11000, startingAmount: 10000, targetDate: daysFromNow(365) },
    });
    const decision = await strategy.analyze(params);
    expect(decision.shouldRebalance).toBe(false);
    expect(decision.reasoning).toContain('On track');
    expect(decision.details?.requiredApy).toBeCloseTo(10, 1);
  });

  it('ahead-of-schedule: does not rebalance when current APY comfortably exceeds the required rate', async () => {
    // Required: (10500-10000)/10000/2 = 2.5%. Current APY of 15% is well ahead.
    const params = baseParams({
      currentApy: 15,
      availableProtocols: [makeProtocol({ name: 'Blend', apy: 15 })],
      goal: { targetAmount: 10500, startingAmount: 10000, targetDate: daysFromNow(730) },
    });
    const decision = await strategy.analyze(params);
    expect(decision.shouldRebalance).toBe(false);
    expect(decision.reasoning).toContain('On track');
    expect(decision.details?.requiredApy).toBeCloseTo(2.5, 1);
  });

  it('behind schedule: delegates to MaxYieldStrategy when required rate is reachable', async () => {
    // Required: (13000-10000)/10000/1 = 30%. Current APY 3%, but Luma offers 35%.
    const params = baseParams({
      currentProtocol: 'Blend',
      currentApy: 3,
      availableProtocols: [
        makeProtocol({ name: 'Luma', apy: 35 }),
        makeProtocol({ name: 'Blend', apy: 3 }),
      ],
      goal: { targetAmount: 13000, startingAmount: 10000, targetDate: daysFromNow(365) },
    });
    const decision = await strategy.analyze(params);
    expect(decision.shouldRebalance).toBe(true);
    expect(decision.targetProtocol).toBe('Luma');
    expect(decision.reasoning).toContain('Behind schedule');
    expect(decision.details?.requiredApy).toBeCloseTo(30, 1);
  });

  it('unreachable-within-risk-ceiling: surfaces target-not-reachable instead of exceeding the ceiling', async () => {
    // Required: (20000-10000)/10000/1 = 100%. No protocol comes close.
    const params = baseParams({
      currentProtocol: 'Blend',
      currentApy: 3,
      availableProtocols: [
        makeProtocol({ name: 'Blend', apy: 3 }),
        makeProtocol({ name: 'Luma', apy: 8 }),
      ],
      goal: { targetAmount: 20000, startingAmount: 10000, targetDate: daysFromNow(365) },
    });
    const decision = await strategy.analyze(params);
    expect(decision.shouldRebalance).toBe(false);
    expect(decision.reasoning).toContain('not reachable within your risk tolerance');
    expect(decision.details?.unreachable).toBe(true);
  });

  it('unreachable-within-risk-ceiling: never overrides an explicit riskCeiling that excludes every protocol', async () => {
    const params = baseParams({
      currentProtocol: 'Blend',
      currentApy: 3,
      availableProtocols: [
        makeProtocol({ name: 'Blend', apy: 3 }),
        makeProtocol({ name: 'Luma', apy: 35 }),
      ],
      riskCeiling: 80,
      protocolRiskScores: { Blend: 40, Luma: 20 },
      goal: { targetAmount: 13000, startingAmount: 10000, targetDate: daysFromNow(365) },
    });
    const decision = await strategy.analyze(params);
    expect(decision.shouldRebalance).toBe(false);
    expect(decision.reasoning).toBe(NO_ELIGIBLE_PROTOCOLS_REASON);
  });
});
