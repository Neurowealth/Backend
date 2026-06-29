import { MaxYieldStrategy, TargetAllocationStrategy } from '../../../src/agent/strategies';
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

const defaultThresholds = {
  minimumImprovement: 0.5,
  maxGasPercent: 0.1,
};

describe('MaxYieldStrategy', () => {
  const strategy = new MaxYieldStrategy();

  it('returns strategy name as MAX_YIELD', () => {
    expect(strategy.name).toBe('MAX_YIELD');
  });

  it('recommends rebalance when a better protocol exists and net gain exceeds threshold', async () => {
    // Use 10000 USDC so gas costs (~$0.50) are negligible (0.005%)
    const params: StrategyParams = {
      currentProtocol: 'Blend',
      totalAmount: '10000000000000000000000',
      currentApy: 3.0,
      availableProtocols: [
        makeProtocol({ name: 'Luma', apy: 8.0 }),
        makeProtocol({ name: 'Blend', apy: 3.0 }),
      ],
      thresholds: defaultThresholds,
      userStrategyPreferences: [],
    };

    const decision = await strategy.analyze(params);
    expect(decision.shouldRebalance).toBe(true);
    expect(decision.targetProtocol).toBe('Luma');
    expect(decision.reasoning).toContain('Luma');
    expect(decision.deviationTrigger).toContain('APY delta');
    expect(decision.details).toBeDefined();
  });

  it('does NOT rebalance when current protocol is already the best', async () => {
    const params: StrategyParams = {
      currentProtocol: 'Blend',
      totalAmount: '10000000000000000000',
      currentApy: 8.0,
      availableProtocols: [
        makeProtocol({ name: 'Blend', apy: 8.0 }),
        makeProtocol({ name: 'Luma', apy: 5.0 }),
      ],
      thresholds: defaultThresholds,
      userStrategyPreferences: [],
    };

    const decision = await strategy.analyze(params);
    expect(decision.shouldRebalance).toBe(false);
    expect(decision.targetProtocol).toBe('Blend');
    expect(decision.reasoning).toContain('Already on the highest-yielding');
  });

  it('does NOT rebalance when net improvement is below threshold', async () => {
    const params: StrategyParams = {
      currentProtocol: 'Blend',
      totalAmount: '10000000000000000000',
      currentApy: 7.8,
      availableProtocols: [
        makeProtocol({ name: 'Luma', apy: 8.0 }),
        makeProtocol({ name: 'Blend', apy: 7.8 }),
      ],
      thresholds: defaultThresholds,
      userStrategyPreferences: [],
    };

    const decision = await strategy.analyze(params);
    expect(decision.shouldRebalance).toBe(false);
    expect(decision.reasoning).toContain('below threshold');
  });

  it('does NOT rebalance when no protocols are available', async () => {
    const params: StrategyParams = {
      currentProtocol: 'Blend',
      totalAmount: '10000000000000000000',
      currentApy: 5.0,
      availableProtocols: [],
      thresholds: defaultThresholds,
      userStrategyPreferences: [],
    };

    const decision = await strategy.analyze(params);
    expect(decision.shouldRebalance).toBe(false);
    expect(decision.reasoning).toContain('No protocols available');
  });

  it('handles very small amounts without crashing', async () => {
    const params: StrategyParams = {
      currentProtocol: 'Blend',
      totalAmount: '1',
      currentApy: 3.0,
      availableProtocols: [
        makeProtocol({ name: 'Luma', apy: 8.0 }),
      ],
      thresholds: defaultThresholds,
      userStrategyPreferences: [],
    };

    const decision = await strategy.analyze(params);
    expect(decision.shouldRebalance).toBe(false);
    expect(decision.reasoning).toBeDefined();
  });
});

describe('TargetAllocationStrategy', () => {
  const strategy = new TargetAllocationStrategy();

  it('returns strategy name as TARGET_ALLOCATION', () => {
    expect(strategy.name).toBe('TARGET_ALLOCATION');
  });

  it('recommends rebalance when protocol has significantly lower target than the preferred protocol', async () => {
    const params: StrategyParams = {
      currentProtocol: 'Blend',
      totalAmount: '10000000000000000000000',
      currentApy: 5.0,
      availableProtocols: [
        makeProtocol({ name: 'Luma', apy: 6.0 }),
        makeProtocol({ name: 'Blend', apy: 5.0 }),
      ],
      thresholds: defaultThresholds,
      userStrategyPreferences: [
        {
          userId: 'user-1',
          strategyName: 'TARGET_ALLOCATION',
          targetAllocations: { Blend: 30, 'Stellar DEX': 40, Luma: 30 },
        },
      ],
    };

    const decision = await strategy.analyze(params);
    expect(decision.shouldRebalance).toBe(true);
    expect(decision.targetProtocol).toBe('Stellar DEX');
    expect(decision.reasoning).toContain('significantly below');
    expect(decision.deviationTrigger).toContain('Target ratio');
    expect(decision.details).toBeDefined();
  });

  it('does NOT rebalance when targets are within acceptable range of each other', async () => {
    const params: StrategyParams = {
      currentProtocol: 'Blend',
      totalAmount: '10000000000000000000',
      currentApy: 5.0,
      availableProtocols: [
        makeProtocol({ name: 'Luma', apy: 6.0 }),
        makeProtocol({ name: 'Blend', apy: 5.0 }),
      ],
      thresholds: defaultThresholds,
      userStrategyPreferences: [
        {
          userId: 'user-1',
          strategyName: 'TARGET_ALLOCATION',
          targetAllocations: { Blend: 33, 'Stellar DEX': 33, Luma: 34 },
        },
      ],
    };

    const decision = await strategy.analyze(params);
    expect(decision.shouldRebalance).toBe(false);
    expect(decision.reasoning).toContain('within acceptable range');
  });

  it('does NOT rebalance when no target allocations configured', async () => {
    const params: StrategyParams = {
      currentProtocol: 'Blend',
      totalAmount: '10000000000000000000',
      currentApy: 5.0,
      availableProtocols: [
        makeProtocol({ name: 'Luma', apy: 6.0 }),
      ],
      thresholds: defaultThresholds,
      userStrategyPreferences: [
        { userId: 'user-1', strategyName: 'TARGET_ALLOCATION' },
      ],
    };

    const decision = await strategy.analyze(params);
    expect(decision.shouldRebalance).toBe(false);
    expect(decision.reasoning).toContain('No target allocations configured');
  });

  it('does NOT rebalance when no preferences match', async () => {
    const params: StrategyParams = {
      currentProtocol: 'Blend',
      totalAmount: '10000000000000000000',
      currentApy: 5.0,
      availableProtocols: [
        makeProtocol({ name: 'Luma', apy: 6.0 }),
      ],
      thresholds: defaultThresholds,
      userStrategyPreferences: [],
    };

    const decision = await strategy.analyze(params);
    expect(decision.shouldRebalance).toBe(false);
    expect(decision.reasoning).toContain('No target allocations configured');
  });

  it('does NOT rebalance when current protocol has no target', async () => {
    const params: StrategyParams = {
      currentProtocol: 'UnknownProtocol',
      totalAmount: '10000000000000000000',
      currentApy: 5.0,
      availableProtocols: [
        makeProtocol({ name: 'Luma', apy: 6.0 }),
      ],
      thresholds: defaultThresholds,
      userStrategyPreferences: [
        {
          userId: 'user-1',
          strategyName: 'TARGET_ALLOCATION',
          targetAllocations: { Blend: 50, Luma: 50 },
        },
      ],
    };

    const decision = await strategy.analyze(params);
    expect(decision.shouldRebalance).toBe(false);
    expect(decision.reasoning).toContain('No target allocation set');
  });
});
