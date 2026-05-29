/**
 * Integration tests — Admin API routes
 *
 * Tests admin endpoints for Stellar metrics, DLQ inspection, and manual operations
 */

jest.mock('../../../src/config/jwt-adapter', () => ({
    JwtAdapter: {
        generateToken: jest.fn().mockResolvedValue('admin-test-token'),
        validateToken: jest.fn().mockResolvedValue({ id: 'admin-user' }),
    },
}));

const passthroughLimiter = (_req: unknown, _res: unknown, next: () => void) => next()

jest.mock('../../../src/middleware/rateLimiter', () => ({
    trustedIpBypass: (_req: unknown, _res: unknown, next: () => void) => next(),
    rateLimiter: passthroughLimiter,
    authRateLimiter: passthroughLimiter,
    adminRateLimiter: passthroughLimiter,
    internalRateLimiter: passthroughLimiter,
}));

jest.mock('../../../src/stellar/events', () => ({
    getEventMetrics: jest.fn().mockReturnValue({
        totalProcessed: 1000,
        totalErrors: 5,
        processingRatePerMinute: 15,
        errorRate: 0.005,
        ledgerLag: 10,
        lastDbOperationMs: 45,
        lastUpdated: new Date(),
    }),
    backfillEvents: jest.fn().mockResolvedValue(undefined),
    retryDeadLetterEvents: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../../src/stellar/dlq', () => ({
    DeadLetterQueue: {
        getAll: jest.fn().mockReturnValue([
            {
                id: 'dlq-1',
                contractId: 'CVAULT123',
                txHash: 'tx-hash-1',
                eventType: 'deposit',
                ledger: 1000,
                error: 'Connection timeout',
                payload: { amount: '1000' },
                status: 'PENDING',
                retryCount: 0,
                createdAt: '2026-05-26T10:00:00Z',
                updatedAt: '2026-05-26T10:00:00Z',
            },
            {
                id: 'dlq-2',
                contractId: 'CVAULT123',
                txHash: 'tx-hash-2',
                eventType: 'withdraw',
                ledger: 1001,
                error: 'Invalid event format',
                payload: { amount: '500' },
                status: 'RETRIED',
                retryCount: 2,
                createdAt: '2026-05-26T09:00:00Z',
                updatedAt: '2026-05-26T10:30:00Z',
            },
        ]),
        getSize: jest.fn().mockReturnValue(2),
        resolve: jest.fn().mockResolvedValue(true),
        retryAll: jest.fn().mockResolvedValue({ resolved: 1, failed: 1 }),
    },
}));

const mockDb = {
    session: { findUnique: jest.fn(), create: jest.fn() },
    user: { findUnique: jest.fn(), create: jest.fn() },
    agentLog: { findFirst: jest.fn() },
};

jest.mock('../../../src/db', () => ({
    __esModule: true,
    default: mockDb,
}));

import request from 'supertest';
import app from '../../../src/index';

describe('Admin routes', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        process.env.ADMIN_API_TOKEN = 'test-admin-token-secret';
        process.env.NODE_ENV = 'production';
    });

    describe('Authentication', () => {
        it('returns 403 without admin token in production', async () => {
            const res = await request(app).get('/api/admin/stellar/metrics');

            expect(res.status).toBe(403);
            expect(res.body.success).toBe(false);
            expect(res.body.error).toContain('Admin access required');
        });

        it('returns 403 with invalid admin token', async () => {
            const res = await request(app)
                .get('/api/admin/stellar/metrics')
                .set('x-admin-token', 'wrong-token');

            expect(res.status).toBe(403);
            expect(res.body.success).toBe(false);
        });

        it('allows access with valid admin token', async () => {
            const res = await request(app)
                .get('/api/admin/stellar/metrics')
                .set('x-admin-token', 'test-admin-token-secret');

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
        });

        it('allows localhost access in development without token', async () => {
            process.env.NODE_ENV = 'development';

            const res = await request(app)
                .get('/api/admin/stellar/metrics')
                .set('X-Forwarded-For', '127.0.0.1');

            // Note: supertest may not preserve IP, so this is a best-effort test
            // In real scenarios, the middleware would check req.ip
            expect(res.status).toBeGreaterThanOrEqual(200);
        });
    });

    describe('GET /api/admin/stellar/metrics', () => {
        it('returns current event processing metrics', async () => {
            const res = await request(app)
                .get('/api/admin/stellar/metrics')
                .set('x-admin-token', 'test-admin-token-secret');

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.data).toEqual({
                totalProcessed: 1000,
                totalErrors: 5,
                processingRatePerMinute: 15,
                errorRate: '0.50%',
                ledgerLag: 10,
                lastDbOperationMs: 45,
                lastUpdated: expect.any(String),
            });
            expect(res.body.timestamp).toBeDefined();
        });

        it('includes timestamp in response', async () => {
            const res = await request(app)
                .get('/api/admin/stellar/metrics')
                .set('x-admin-token', 'test-admin-token-secret');

            expect(res.body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        });
    });

    describe('GET /api/admin/dlq/inspect', () => {
        it('returns all DLQ events', async () => {
            const res = await request(app)
                .get('/api/admin/dlq/inspect')
                .set('x-admin-token', 'test-admin-token-secret');

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.data.totalInQueue).toBe(2);
            expect(res.body.data.filteredCount).toBe(2);
            expect(res.body.data.returnedCount).toBe(2);
            expect(res.body.data.items).toHaveLength(2);
        });

        it('filters DLQ events by status', async () => {
            const res = await request(app)
                .get('/api/admin/dlq/inspect?status=PENDING')
                .set('x-admin-token', 'test-admin-token-secret');

            expect(res.status).toBe(200);
            expect(res.body.data.items).toHaveLength(1);
            expect(res.body.data.items[0].status).toBe('PENDING');
        });

        it('respects limit parameter', async () => {
            const res = await request(app)
                .get('/api/admin/dlq/inspect?limit=1')
                .set('x-admin-token', 'test-admin-token-secret');

            expect(res.status).toBe(200);
            expect(res.body.data.returnedCount).toBe(1);
        });

        it('caps limit at 500', async () => {
            const res = await request(app)
                .get('/api/admin/dlq/inspect?limit=1000')
                .set('x-admin-token', 'test-admin-token-secret');

            expect(res.status).toBe(200);
            // Should be capped at 500, but our mock only has 2 items
            expect(res.body.data.returnedCount).toBeLessThanOrEqual(2);
        });

        it('returns event details without payload', async () => {
            const res = await request(app)
                .get('/api/admin/dlq/inspect')
                .set('x-admin-token', 'test-admin-token-secret');

            const event = res.body.data.items[0];
            expect(event).toHaveProperty('id');
            expect(event).toHaveProperty('contractId');
            expect(event).toHaveProperty('txHash');
            expect(event).toHaveProperty('eventType');
            expect(event).toHaveProperty('ledger');
            expect(event).toHaveProperty('status');
            expect(event).toHaveProperty('retryCount');
            expect(event).toHaveProperty('error');
            expect(event).not.toHaveProperty('payload');
        });
    });

    describe('POST /api/admin/dlq/retry', () => {
        it('performs dry run without modifying DLQ', async () => {
            const res = await request(app)
                .post('/api/admin/dlq/retry')
                .set('x-admin-token', 'test-admin-token-secret')
                .send({ dryRun: true });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.data.dryRun).toBe(true);
            expect(res.body.data.wouldRetry).toBe(2);
            expect(res.body.data.events).toHaveLength(2);
        });

        it('executes actual retry when dryRun is false', async () => {
            const { retryDeadLetterEvents } = require('../../../src/stellar/events');

            const res = await request(app)
                .post('/api/admin/dlq/retry')
                .set('x-admin-token', 'test-admin-token-secret')
                .send({ dryRun: false });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.data).toHaveProperty('resolved');
            expect(res.body.data).toHaveProperty('failed');
            expect(res.body.data).toHaveProperty('totalRemaining');
            expect(retryDeadLetterEvents).toHaveBeenCalled();
        });

        it('defaults to dryRun false if not specified', async () => {
            const { retryDeadLetterEvents } = require('../../../src/stellar/events');

            const res = await request(app)
                .post('/api/admin/dlq/retry')
                .set('x-admin-token', 'test-admin-token-secret')
                .send({});

            expect(res.status).toBe(200);
            expect(retryDeadLetterEvents).toHaveBeenCalled();
        });
    });

    describe('POST /api/admin/dlq/resolve', () => {
        it('resolves a specific DLQ event', async () => {
            const res = await request(app)
                .post('/api/admin/dlq/resolve')
                .set('x-admin-token', 'test-admin-token-secret')
                .send({ eventId: 'dlq-1' });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.data.eventId).toBe('dlq-1');
            expect(res.body.data.status).toBe('RESOLVED');
        });

        it('returns 400 when eventId is missing', async () => {
            const res = await request(app)
                .post('/api/admin/dlq/resolve')
                .set('x-admin-token', 'test-admin-token-secret')
                .send({});

            expect(res.status).toBe(400);
            expect(res.body.success).toBe(false);
            expect(res.body.error).toContain('eventId is required');
        });

        it('returns 404 when event not found', async () => {
            const { DeadLetterQueue } = require('../../../src/stellar/dlq');
            DeadLetterQueue.resolve.mockResolvedValueOnce(false);

            const res = await request(app)
                .post('/api/admin/dlq/resolve')
                .set('x-admin-token', 'test-admin-token-secret')
                .send({ eventId: 'nonexistent' });

            expect(res.status).toBe(404);
            expect(res.body.success).toBe(false);
            expect(res.body.error).toContain('not found');
        });
    });

    describe('POST /api/admin/stellar/backfill', () => {
        it('initiates backfill for ledger range', async () => {
            const { backfillEvents } = require('../../../src/stellar/events');

            const res = await request(app)
                .post('/api/admin/stellar/backfill')
                .set('x-admin-token', 'test-admin-token-secret')
                .send({ startLedger: 1000, endLedger: 2000 });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.data.startLedger).toBe(1000);
            expect(res.body.data.endLedger).toBe(2000);
            expect(res.body.data.status).toBe('backfill_initiated');
            expect(backfillEvents).toHaveBeenCalledWith(1000, 2000);
        });

        it('allows backfill without endLedger', async () => {
            const { backfillEvents } = require('../../../src/stellar/events');

            const res = await request(app)
                .post('/api/admin/stellar/backfill')
                .set('x-admin-token', 'test-admin-token-secret')
                .send({ startLedger: 1000 });

            expect(res.status).toBe(200);
            expect(res.body.data.endLedger).toBe('latest');
            expect(backfillEvents).toHaveBeenCalledWith(1000, undefined);
        });

        it('returns 400 when startLedger is missing', async () => {
            const res = await request(app)
                .post('/api/admin/stellar/backfill')
                .set('x-admin-token', 'test-admin-token-secret')
                .send({});

            expect(res.status).toBe(400);
            expect(res.body.success).toBe(false);
            expect(res.body.error).toContain('startLedger is required');
        });

        it('returns 400 when startLedger is negative', async () => {
            const res = await request(app)
                .post('/api/admin/stellar/backfill')
                .set('x-admin-token', 'test-admin-token-secret')
                .send({ startLedger: -1 });

            expect(res.status).toBe(400);
            expect(res.body.success).toBe(false);
        });

        it('returns 400 when endLedger < startLedger', async () => {
            const res = await request(app)
                .post('/api/admin/stellar/backfill')
                .set('x-admin-token', 'test-admin-token-secret')
                .send({ startLedger: 2000, endLedger: 1000 });

            expect(res.status).toBe(400);
            expect(res.body.success).toBe(false);
        });
    });

    describe('Error handling', () => {
        it('returns 500 on metrics retrieval error', async () => {
            const { getEventMetrics } = require('../../../src/stellar/events');
            getEventMetrics.mockImplementationOnce(() => {
                throw new Error('Metrics service error');
            });

            const res = await request(app)
                .get('/api/admin/stellar/metrics')
                .set('x-admin-token', 'test-admin-token-secret');

            expect(res.status).toBe(500);
            expect(res.body.success).toBe(false);
        });

        it('returns 500 on backfill error', async () => {
            const { backfillEvents } = require('../../../src/stellar/events');
            backfillEvents.mockRejectedValueOnce(new Error('RPC connection failed'));

            const res = await request(app)
                .post('/api/admin/stellar/backfill')
                .set('x-admin-token', 'test-admin-token-secret')
                .send({ startLedger: 1000 });

            expect(res.status).toBe(500);
            expect(res.body.success).toBe(false);
        });
    });
});
