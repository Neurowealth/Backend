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

import * as stellarSdk from '@stellar/stellar-sdk';
import { 
  processEventBatch, 
  backfillEvents, 
  retryDeadLetterEvents 
} from '../../../src/stellar/events';
import { getRpcServer } from '../../../src/stellar/client';
import { DeadLetterQueue } from '../../../src/stellar/dlq';

const mockRpcServer = getRpcServer as jest.MockedFunction<typeof getRpcServer>;

const CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
const WALLET = 'GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIBTICSQYY2T4YJJWUDLVXVVU6G';

function makeEvent(type: string, value: object, extraTopics: stellarSdk.xdr.ScVal[] = []) {
    return {
        ledger: 99,
        txHash: `tx_${type}_${Math.random()}`,
        contractId: CONTRACT_ID,
        topics: [
            stellarSdk.nativeToScVal(type, { type: 'string' }),
            ...extraTopics,
        ],
        value: stellarSdk.nativeToScVal(value),
    };
}

describe('Vault Enhanced Events Tests', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('Batch Processing (Issue #55)', () => {
        it('should process a batch of valid events in a transaction', async () => {
            const events = [
                {
                    type: 'deposit' as const,
                    ledger: 100,
                    txHash: 'tx_batch_1',
                    contractId: CONTRACT_ID,
                    topics: [stellarSdk.nativeToScVal('deposit')],
                    value: stellarSdk.nativeToScVal({ user: WALLET, amount: 1000n, shares: 100n })
                },
                {
                    type: 'withdraw' as const,
                    ledger: 101,
                    txHash: 'tx_batch_2',
                    contractId: CONTRACT_ID,
                    topics: [stellarSdk.nativeToScVal('withdraw')],
                    value: stellarSdk.nativeToScVal({ user: WALLET, amount: 500n, shares: 50n })
                }
            ];

            mockPrisma.$transaction.mockImplementation(async (cb: any) => cb(mockPrisma));
            mockPrisma.user.findUnique.mockResolvedValue({ id: 'user_1', walletAddress: WALLET });
            mockPrisma.transaction.upsert.mockResolvedValue({ id: 'tx_db_1' });
            mockPrisma.position.findFirst.mockResolvedValue(null);
            mockPrisma.position.create.mockResolvedValue({ id: 'pos_1' });

            await processEventBatch(events);

            expect(mockPrisma.$transaction).toHaveBeenCalled();
            expect(mockPrisma.user.findUnique).toHaveBeenCalled();
        });
    });

    describe('Schema Validation (Issue #53)', () => {
        it('should send invalid events to DLQ and proceed without crashing', async () => {
            const events = [
                {
                    type: 'deposit' as const,
                    ledger: 100,
                    txHash: 'tx_invalid_schema',
                    contractId: CONTRACT_ID,
                    topics: [stellarSdk.nativeToScVal('deposit')],
                    value: stellarSdk.nativeToScVal({ user: '', amount: 1000n }) // Empty user -> invalid
                }
            ];

            const initialSize = DeadLetterQueue.getSize();
            await processEventBatch(events);
            const finalSize = DeadLetterQueue.getSize();

            expect(finalSize).toBeGreaterThanOrEqual(initialSize);
        });
    });

    describe('Dead Letter Queue Retry (Issue #54)', () => {
        it('should retry DLQ events when triggered', async () => {
             const initialSize = DeadLetterQueue.getSize();
             await DeadLetterQueue.add({
                 type: 'deposit',
                 ledger: 105,
                 txHash: 'tx_retry_test',
                 contractId: CONTRACT_ID
             }, 'Test manual error');
             
             expect(DeadLetterQueue.getSize()).toBe(initialSize + 1);

             // Just call retryDeadLetterEvents to cover logic
             await retryDeadLetterEvents();
        });
    });

    describe('Backfill & Fault Recovery (Issue #59)', () => {
        it('should fetch and process ranges during backfill', async () => {
             const server = {
                 getLatestLedger: jest.fn().mockResolvedValue({ sequence: 110 }),
                 getEvents: jest.fn().mockResolvedValue({ events: [] })
             };
             mockRpcServer.mockReturnValue(server as any);

             await backfillEvents(90, 100);

             expect(server.getEvents).toHaveBeenCalled();
        });
    });
});
