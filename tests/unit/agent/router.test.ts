/**
 * Unit tests for src/agent/router.ts
 *
 * Scanner functions and Prisma are mocked — no real DB or network calls.
 */

jest.mock('../../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Mock scanner dependency
jest.mock('../../../src/agent/scanner', () => ({
  scanAllProtocols: jest.fn(),
  getCurrentOnChainApy: jest.fn(),
  getBestProtocol: jest.fn(),
}));

const mockFindFirst = jest.fn();
const mockTransactionCreate = jest.fn();
const mockAgentLogCreate = jest.fn().mockResolvedValue({});
const mockContractTriggerRebalance = jest.fn();

// Mock Prisma used by logAgentAction
jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    user: {
      findMany: jest.fn().mockResolvedValue([{ id: 'test-user-id' }]),
    },
    position: {
      findFirst: (...args: unknown[]) => mockFindFirst(...args),
    },
    transaction: {
      create: (...args: unknown[]) => mockTransactionCreate(...args),
    },
    agentLog: {
      create: (...args: unknown[]) => mockAgentLogCreate(...args),
    },
  })),
}));

jest.mock('../../../src/stellar/contract', () => ({
  triggerRebalance: (...args: unknown[]) => mockContractTriggerRebalance(...args),
}));

import {
  compareProtocols,
  executeRebalanceIfNeeded,
  getThresholds,
  triggerRebalance,
} from '../../../src/agent/router';
import {
  scanAllProtocols,
  getCurrentOnChainApy,
} from '../../../src/agent/scanner';

const mockScan = scanAllProtocols as jest.Mock;
const mockApy = getCurrentOnChainApy as jest.Mock;

// A Blend protocol stub with a very high APY used to trigger rebalances
const blendProtocol = {
  name: 'Blend',
  apy: 8.0,
  tvl: 50_000_000,
  assetSymbol: 'USDC',
  lastUpdated: new Date(),
  isAvailable: true,
};

// A marginal improvement that does NOT exceed the 0.5% threshold after costs
const marginalProtocol = {
  ...blendProtocol,
  apy: 4.3, // current = 4.0  → raw gain ≈ 0.3 → net < 0.5
};

describe('Agent Router', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindFirst.mockResolvedValue({
      id: 'pos-1',
      userId: 'test-user-id',
      assetSymbol: 'USDC',
      user: { network: 'TESTNET' },
    });
    mockTransactionCreate.mockResolvedValue({});
    mockAgentLogCreate.mockResolvedValue({});
    mockContractTriggerRebalance.mockResolvedValue({
      hash: 'real-rebalance-hash-001',
      status: 'success',
      ledger: 77,
    });
  });

  // ── compareProtocols ──────────────────────────────────────────────────────

  describe('compareProtocols()', () => {
    it('returns null when current APY cannot be fetched', async () => {
      mockApy.mockResolvedValue(null);
      const result = await compareProtocols('Blend');
      expect(result).toBeNull();
    });

    it('returns null when no protocols are available', async () => {
      mockApy.mockResolvedValue(4.0);
      mockScan.mockResolvedValue([]);
      const result = await compareProtocols('Blend');
      expect(result).toBeNull();
    });

    it('sets shouldRebalance=false when net improvement is below threshold', async () => {
      mockApy.mockResolvedValue(4.0);
      mockScan.mockResolvedValue([marginalProtocol]);
      const result = await compareProtocols('Stellar DEX');
      expect(result).not.toBeNull();
      expect(result!.shouldRebalance).toBe(false);
    });

    it('sets shouldRebalance=true when net improvement clearly exceeds threshold', async () => {
      mockApy.mockResolvedValue(2.0);
      mockScan.mockResolvedValue([blendProtocol]);
      // Pass a large amount so gas fee % is negligible
      const result = await compareProtocols(
        'Stellar DEX',
        '100000000000000000000000',
      );
      expect(result!.shouldRebalance).toBe(true);
    });

    it('sets shouldRebalance=false when best protocol is the same as current', async () => {
      mockApy.mockResolvedValue(4.0);
      mockScan.mockResolvedValue([{ ...blendProtocol, apy: 10.0 }]);
      // currentProtocol = 'Blend', best = 'Blend' → same protocol
      const result = await compareProtocols('Blend', '100000000000000000000000');
      expect(result!.shouldRebalance).toBe(false);
    });

    it('includes both current and best protocol data in result', async () => {
      mockApy.mockResolvedValue(3.0);
      mockScan.mockResolvedValue([blendProtocol]);
      const result = await compareProtocols('Luma', '100000000000000000000000');
      expect(result!.current.name).toBe('Luma');
      expect(result!.best.name).toBe('Blend');
    });

    it('returns null when scanner throws', async () => {
      mockApy.mockResolvedValue(4.0);
      mockScan.mockRejectedValue(new Error('scanner failure'));
      const result = await compareProtocols('Blend');
      expect(result).toBeNull();
    });
  });

  // ── getThresholds ─────────────────────────────────────────────────────────

  describe('getThresholds()', () => {
    const originalEnv = process.env;

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it('returns default minimumImprovement of 0.5 when env var is not set', () => {
      delete process.env.REBALANCE_THRESHOLD_PERCENT;
      const t = getThresholds();
      expect(t.minimumImprovement).toBe(0.5);
    });

    it('returns default maxGasPercent of 0.1 when env var is not set', () => {
      delete process.env.MAX_GAS_PERCENT;
      const t = getThresholds();
      expect(t.maxGasPercent).toBe(0.1);
    });

    it('reads REBALANCE_THRESHOLD_PERCENT from environment', () => {
      process.env.REBALANCE_THRESHOLD_PERCENT = '1.5';
      const t = getThresholds();
      expect(t.minimumImprovement).toBe(1.5);
    });

    it('reads MAX_GAS_PERCENT from environment', () => {
      process.env.MAX_GAS_PERCENT = '0.3';
      const t = getThresholds();
      expect(t.maxGasPercent).toBe(0.3);
    });
  });

  // ── executeRebalanceIfNeeded ──────────────────────────────────────────────

  describe('executeRebalanceIfNeeded()', () => {
    it('returns null when net improvement is below threshold', async () => {
      mockApy.mockResolvedValue(4.0);
      mockScan.mockResolvedValue([marginalProtocol]);
      const result = await executeRebalanceIfNeeded('Stellar DEX', [
        { id: 'pos-1', amount: '1000000' },
      ]);
      expect(result).toBeNull();
    });

    it('returns null when compareProtocols returns null', async () => {
      mockApy.mockResolvedValue(null);
      const result = await executeRebalanceIfNeeded('Blend', [
        { id: 'pos-1', amount: '1000000' },
      ]);
      expect(result).toBeNull();
    });

    it('returns rebalance details when improvement exceeds threshold', async () => {
      mockApy.mockResolvedValue(2.0);
      mockScan.mockResolvedValue([blendProtocol]);
      const result = await executeRebalanceIfNeeded('Stellar DEX', [
        { id: 'pos-1', amount: '100000000000000000000000' },
      ]);
      expect(result).not.toBeNull();
      expect(result!.fromProtocol).toBe('Stellar DEX');
      expect(result!.toProtocol).toBe('Blend');
      expect(result!.txHash).toBe('real-rebalance-hash-001');
      expect(mockContractTriggerRebalance).toHaveBeenCalledWith('Blend', 800);
      expect(mockTransactionCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: 'REBALANCE',
            status: 'PENDING',
            txHash: 'real-rebalance-hash-001',
            protocolName: 'Blend',
          }),
        }),
      );
    });

    it('sums amounts across multiple positions before cost calculation', async () => {
      mockApy.mockResolvedValue(2.0);
      mockScan.mockResolvedValue([blendProtocol]);
      const result = await executeRebalanceIfNeeded('Stellar DEX', [
        { id: 'pos-1', amount: '50000000000000000000000' },
        { id: 'pos-2', amount: '50000000000000000000000' },
      ]);
      // Combined = 100 000… should still cross threshold
      expect(result).not.toBeNull();
    });

    it('returns null when scanner throws during check', async () => {
      mockApy.mockRejectedValue(new Error('network error'));
      const result = await executeRebalanceIfNeeded('Blend', [
        { id: 'pos-1', amount: '100000000000000000000000' },
      ]);
      expect(result).toBeNull();
    });
  });

  describe('triggerRebalance()', () => {
    it('converts APY percent to basis points before invoking the vault contract', async () => {
      mockApy.mockResolvedValue(2.0);
      mockScan.mockResolvedValue([blendProtocol]);

      const result = await triggerRebalance(
        'Stellar DEX',
        'Blend',
        '100000000000000000000000',
        ['pos-1'],
      );

      expect(result?.txHash).toBe('real-rebalance-hash-001');
      expect(mockContractTriggerRebalance).toHaveBeenCalledWith('Blend', 800);
    });

    it('skips transaction persistence when no representative position is found', async () => {
      mockApy.mockResolvedValue(2.0);
      mockScan.mockResolvedValue([blendProtocol]);
      mockFindFirst.mockResolvedValueOnce(null);

      const result = await triggerRebalance(
        'Stellar DEX',
        'Blend',
        '100000000000000000000000',
        ['missing-pos'],
      );

      expect(result?.txHash).toBe('real-rebalance-hash-001');
      expect(mockTransactionCreate).not.toHaveBeenCalled();
    });
  });
});
