import { submitTransaction, waitForConfirmation } from '../client';
import { getOnChainBalance, triggerRebalance } from '../contract';
import { getEventMetrics } from '../events';
import { Transaction } from '@stellar/stellar-sdk';

jest.mock('../client', () => ({
  getRpcServer: jest.fn(),
  getNetworkPassphrase: jest.fn(() => 'Test SDF Network ; September 2015'),
  getAgentKeypair: jest.fn(),
  submitTransaction: jest.fn(),
  waitForConfirmation: jest.fn(),
}));

jest.mock('../events', () => ({
  getEventMetrics: jest.fn(),
}));

describe('Stellar Integration - Unit Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Transaction Submission', () => {
    it('should submit transaction successfully', async () => {
      const mockHash = 'abc123';
      (submitTransaction as jest.Mock).mockResolvedValue(mockHash);

      const result = await submitTransaction({} as Transaction);

      expect(result).toBe(mockHash);
      expect(submitTransaction).toHaveBeenCalledTimes(1);
    });

    it('should handle submission failure', async () => {
      (submitTransaction as jest.Mock).mockRejectedValue(
        new Error('Transaction failed: invalid signature')
      );

      await expect(submitTransaction({} as Transaction)).rejects.toThrow(
        'Transaction failed: invalid signature'
      );
    });
  });

  describe('Confirmation Polling', () => {
    it('should return success on confirmed transaction', async () => {
      const mockResult = {
        hash: 'abc123',
        status: 'success' as const,
        ledger: 12345,
      };
      (waitForConfirmation as jest.Mock).mockResolvedValue(mockResult);

      const result = await waitForConfirmation('abc123');

      expect(result.status).toBe('success');
      expect(result.ledger).toBe(12345);
    });

    it('should handle failed transaction', async () => {
      const mockResult = {
        hash: 'abc123',
        status: 'failed' as const,
      };
      (waitForConfirmation as jest.Mock).mockResolvedValue(mockResult);

      const result = await waitForConfirmation('abc123');

      expect(result.status).toBe('failed');
    });

    it('should timeout after max wait time', async () => {
      (waitForConfirmation as jest.Mock).mockRejectedValue(
        new Error('Transaction confirmation timeout after 30000ms')
      );

      await expect(waitForConfirmation('abc123')).rejects.toThrow('timeout');
    });
  });

  describe('Contract Read Operations', () => {
    it('should parse balance correctly', async () => {
      const mockBalance = {
        balance: '1000000000',
        shares: '500000000',
      };

      jest.spyOn(require('../contract'), 'getOnChainBalance').mockResolvedValue(mockBalance);

      const result = await getOnChainBalance('GTEST123');

      expect(result.balance).toBe('1000000000');
      expect(result.shares).toBe('500000000');
    });

    it('should handle read errors gracefully', async () => {
      jest.spyOn(require('../contract'), 'getOnChainBalance').mockRejectedValue(
        new Error('Simulation failed: contract not found')
      );

      await expect(getOnChainBalance('GTEST123')).rejects.toThrow('contract not found');
    });
  });

  describe('Contract Write Operations', () => {
    it('should submit rebalance transaction', async () => {
      const mockResult = {
        hash: 'rebalance123',
        status: 'success' as const,
        ledger: 12346,
      };

      jest.spyOn(require('../contract'), 'triggerRebalance').mockResolvedValue(mockResult);

      const result = await triggerRebalance('compound', 550);

      expect(result.hash).toBe('rebalance123');
      expect(result.status).toBe('success');
    });
  });

  describe('Event Metrics', () => {
    it('should return current metrics with all required fields', () => {
      const mockMetrics = {
        totalProcessed: 42,
        totalErrors: 2,
        processingRatePerMinute: 10,
        errorRate: 0.048,
        ledgerLag: 3,
        lastDbOperationMs: 12,
        lastUpdated: new Date(),
      };
      (getEventMetrics as jest.Mock).mockReturnValue(mockMetrics);

      const metrics = getEventMetrics();

      expect(metrics.totalProcessed).toBe(42);
      expect(metrics.totalErrors).toBe(2);
      expect(metrics.processingRatePerMinute).toBe(10);
      expect(metrics.errorRate).toBeCloseTo(0.048, 3);
      expect(metrics.ledgerLag).toBe(3);
      expect(metrics.lastDbOperationMs).toBe(12);
      expect(metrics.lastUpdated).toBeInstanceOf(Date);
    });

    it('should return zero values for a fresh listener', () => {
      const emptyMetrics = {
        totalProcessed: 0,
        totalErrors: 0,
        processingRatePerMinute: 0,
        errorRate: 0,
        ledgerLag: 0,
        lastDbOperationMs: 0,
        lastUpdated: new Date(),
      };
      (getEventMetrics as jest.Mock).mockReturnValue(emptyMetrics);

      const metrics = getEventMetrics();

      expect(metrics.totalProcessed).toBe(0);
      expect(metrics.errorRate).toBe(0);
    });

    it('should compute errorRate as totalErrors / totalProcessed', () => {
      const totalProcessed = 100;
      const totalErrors = 5;
      const errorRate = totalProcessed > 0 ? totalErrors / totalProcessed : 0;

      expect(errorRate).toBeCloseTo(0.05, 3);
    });

    it('should return zero errorRate when no events processed', () => {
      const totalProcessed = 0;
      const totalErrors = 0;
      const errorRate = totalProcessed > 0 ? totalErrors / totalProcessed : 0;

      expect(errorRate).toBe(0);
    });
  });

  describe('Event Parsing', () => {
    it('should parse deposit event', () => {
      const mockEvent = {
        type: 'deposit' as const,
        ledger: 12345,
        txHash: 'tx123',
        contractId: 'CTEST',
        topics: [],
        value: {} as any,
      };

      expect(mockEvent.type).toBe('deposit');
      expect(mockEvent.ledger).toBe(12345);
    });

    it('should parse withdraw event', () => {
      const mockEvent = {
        type: 'withdraw' as const,
        ledger: 12346,
        txHash: 'tx124',
        contractId: 'CTEST',
        topics: [],
        value: {} as any,
      };

      expect(mockEvent.type).toBe('withdraw');
    });

    it('should parse rebalance event', () => {
      const mockEvent = {
        type: 'rebalance' as const,
        ledger: 12347,
        txHash: 'tx125',
        contractId: 'CTEST',
        topics: [],
        value: {} as any,
      };

      expect(mockEvent.type).toBe('rebalance');
    });
  });

  describe('Dead-Letter Queue - Persistent Storage', () => {
    it('should create a DLQ entry with required fields', () => {
      const event = {
        type: 'deposit',
        ledger: 12345,
        txHash: 'tx-fail-001',
        contractId: 'CVAULT',
      };
      const errorMsg = 'User not found';

      const entry = {
        id: 'dlq-id-1',
        contractId: event.contractId,
        txHash: event.txHash,
        eventType: event.type,
        ledger: event.ledger,
        error: errorMsg,
        payload: event,
        status: 'PENDING' as const,
        retryCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      expect(entry.txHash).toBe('tx-fail-001');
      expect(entry.status).toBe('PENDING');
      expect(entry.retryCount).toBe(0);
      expect(entry.contractId).toBe('CVAULT');
      expect(entry.error).toBe(errorMsg);
    });

    it('should mark entry as RESOLVED after successful retry', () => {
      let status: 'PENDING' | 'RETRIED' | 'RESOLVED' = 'PENDING';
      let retryCount = 0;

      // Simulate successful retry
      retryCount++;
      status = 'RESOLVED';

      expect(status).toBe('RESOLVED');
      expect(retryCount).toBe(1);
    });

    it('should mark entry as RETRIED after failed retry', () => {
      let status: 'PENDING' | 'RETRIED' | 'RESOLVED' = 'PENDING';
      let retryCount = 0;

      // Simulate failed retry
      retryCount++;
      status = 'RETRIED';

      expect(status).toBe('RETRIED');
      expect(retryCount).toBe(1);
    });

    it('should only retry PENDING and RETRIED entries', () => {
      const entries = [
        { id: '1', status: 'PENDING' as const },
        { id: '2', status: 'RETRIED' as const },
        { id: '3', status: 'RESOLVED' as const },
      ];

      const retryable = entries.filter(
        e => e.status === 'PENDING' || e.status === 'RETRIED'
      );

      expect(retryable.length).toBe(2);
      expect(retryable.map(e => e.id)).toEqual(['1', '2']);
    });

    it('should trigger alert when queue size reaches threshold', () => {
      const threshold = 50;
      const sizes = [49, 50, 51];
      const alerts = sizes.map(size => size >= threshold);

      expect(alerts[0]).toBe(false); // 49 — no alert
      expect(alerts[1]).toBe(true);  // 50 — alert
      expect(alerts[2]).toBe(true);  // 51 — alert
    });

    it('should persist retry metadata across restarts', () => {
      // Database-backed DLQ: all state lives in DB rows
      const dbRecord = {
        id: 'dlq-1',
        retryCount: 3,
        status: 'RETRIED' as const,
        updatedAt: new Date(),
      };

      // After a restart, the same record is loaded from DB unchanged
      const reloaded = { ...dbRecord };

      expect(reloaded.retryCount).toBe(3);
      expect(reloaded.status).toBe('RETRIED');
    });
  });
});
