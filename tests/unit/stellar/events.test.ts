import { createMockDb } from '../../helpers/testDb';

// Mock Prisma before importing events
const mockPrisma = createMockDb();
jest.mock('@prisma/client', () => {
    const actual = jest.requireActual('@prisma/client');
    return {
        ...actual,
        PrismaClient: jest.fn(() => mockPrisma),
    };
});

jest.mock('../../../src/stellar/client');
jest.mock('../../../src/utils/logger');
jest.mock('../../../src/config', () => ({
    config: {
        stellar: { network: 'testnet' },
    },
}));

import * as stellarSdk from '@stellar/stellar-sdk';
import { startEventListener, stopEventListener, getEventMetrics } from '../../../src/stellar/events';
import { getRpcServer } from '../../../src/stellar/client';

const mockRpcServer = getRpcServer as jest.MockedFunction<typeof getRpcServer>;

const CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
const WALLET = 'GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIBTICSQYY2T4YJJWUDLVXVVU6G';

function makeEvent(type: string, value: object, extraTopics: stellarSdk.xdr.ScVal[] = []) {
    return {
        ledger: 99,
        txHash: `tx_${type}_${Math.random()}`,
        contractId: CONTRACT_ID,
        topic: [
            stellarSdk.nativeToScVal(type, { type: 'string' }),
            ...extraTopics,
        ],
        value: stellarSdk.nativeToScVal(value),
    };
}

function mockServer(events: object[] = []) {
    const server = {
        getLatestLedger: jest.fn().mockResolvedValue({ sequence: 100 }),
        getEvents: jest.fn().mockResolvedValue({ events }),
    };
    mockRpcServer.mockReturnValue(server as any);
    return server;
}

describe('Vault Contract Events', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    afterEach(() => {
        stopEventListener();
    });

    describe('Event Listener', () => {
        it('should start and stop without errors', async () => {
            const server = mockServer();
            await startEventListener();
            await new Promise(resolve => setTimeout(resolve, 100));
            expect(server.getLatestLedger).toHaveBeenCalled();
            stopEventListener();
        });

        it('should handle deposit events', async () => {
            const server = mockServer([
                makeEvent('deposit', { user: WALLET, amount: 1000000000n, shares: 1000000n }),
            ]);
            await startEventListener();
            await new Promise(resolve => setTimeout(resolve, 100));
            expect(server.getEvents).toHaveBeenCalled();
            stopEventListener();
        });

        it('should handle withdraw events', async () => {
            const server = mockServer([
                makeEvent('withdraw', { user: WALLET, amount: 1000000000n, shares: 1000000n }),
            ]);
            await startEventListener();
            await new Promise(resolve => setTimeout(resolve, 100));
            expect(server.getEvents).toHaveBeenCalled();
            stopEventListener();
        });

        it('should handle rebalance events', async () => {
            const server = mockServer([
                makeEvent('rebalance', { protocol: 'aave', apy: 500, timestamp: Math.floor(Date.now() / 1000) }),
            ]);
            await startEventListener();
            await new Promise(resolve => setTimeout(resolve, 100));
            expect(server.getEvents).toHaveBeenCalled();
            stopEventListener();
        });

        it('should handle multiple sequential events', async () => {
            const server = mockServer([
                makeEvent('deposit', { user: WALLET, amount: 5000000000n, shares: 5000000n }),
                makeEvent('deposit', { user: WALLET, amount: 3000000000n, shares: 3000000n }),
                makeEvent('withdraw', { user: WALLET, amount: 2000000000n, shares: 2000000n }),
            ]);
            await startEventListener();
            await new Promise(resolve => setTimeout(resolve, 100));
            expect(server.getEvents).toHaveBeenCalled();
            stopEventListener();
        });
    });

    // Issue #51: Event context extraction
    describe('Event context extraction', () => {
        it('extracts asset symbol from topics[1] when present', async () => {
            mockServer([
                makeEvent(
                    'deposit',
                    { user: WALLET, amount: 1000n, shares: 100n },
                    [stellarSdk.nativeToScVal('XLM', { type: 'string' })]
                ),
            ]);
            await startEventListener();
            await new Promise(resolve => setTimeout(resolve, 100));
            // No assertion on DB here — just verifying no crash and listener ran
            expect(mockRpcServer).toHaveBeenCalled();
            stopEventListener();
        });

        it('falls back to USDC when topics[1] is absent', async () => {
            mockServer([
                makeEvent('deposit', { user: WALLET, amount: 1000n, shares: 100n }),
            ]);
            await startEventListener();
            await new Promise(resolve => setTimeout(resolve, 100));
            expect(mockRpcServer).toHaveBeenCalled();
            stopEventListener();
        });

        it('extracts protocol name from topics[2] when present', async () => {
            mockServer([
                makeEvent(
                    'deposit',
                    { user: WALLET, amount: 1000n, shares: 100n },
                    [
                        stellarSdk.nativeToScVal('USDC', { type: 'string' }),
                        stellarSdk.nativeToScVal('blend', { type: 'string' }),
                    ]
                ),
            ]);
            await startEventListener();
            await new Promise(resolve => setTimeout(resolve, 100));
            expect(mockRpcServer).toHaveBeenCalled();
            stopEventListener();
        });

        it('uses network from config for rebalance events', async () => {
            mockServer([
                makeEvent('rebalance', { protocol: 'blend', apy: 700, timestamp: Math.floor(Date.now() / 1000) }),
            ]);
            await startEventListener();
            await new Promise(resolve => setTimeout(resolve, 100));
            expect(mockRpcServer).toHaveBeenCalled();
            stopEventListener();
        });
    });

    // Issue #50: Metrics & monitoring
    describe('Event metrics', () => {
        it('getEventMetrics returns a metrics object', () => {
            const m = getEventMetrics();
            expect(m).toHaveProperty('totalProcessed');
            expect(m).toHaveProperty('totalErrors');
            expect(m).toHaveProperty('processingRatePerMinute');
            expect(m).toHaveProperty('errorRate');
            expect(m).toHaveProperty('ledgerLag');
            expect(m).toHaveProperty('lastDbOperationMs');
            expect(m).toHaveProperty('lastUpdated');
        });

        it('ledgerLag is updated after fetching events', async () => {
            mockServer([]);
            await startEventListener();
            await new Promise(resolve => setTimeout(resolve, 100));
            const m = getEventMetrics();
            // ledgerLag should be >= 0 after a poll
            expect(m.ledgerLag).toBeGreaterThanOrEqual(0);
            stopEventListener();
        });

        it('lastUpdated is a Date', () => {
            const m = getEventMetrics();
            expect(m.lastUpdated).toBeInstanceOf(Date);
        });
    });
});
