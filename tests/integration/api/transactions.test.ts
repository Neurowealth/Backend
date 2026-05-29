/**
 * Integration tests — Transactions API routes
 *
 * Tests GET /api/transactions/:userId and GET /api/transactions/detail/:txHash
 * Prisma is mocked; no real database is used.
 */

jest.mock('../../../src/config/jwt-adapter', () => ({
  JwtAdapter: {
    generateToken: jest.fn().mockResolvedValue('mock-token'),
    validateToken: jest.fn().mockResolvedValue({ id: 'mock-user-id' }),
  },
}))

const mockDb = {
  session: { findUnique: jest.fn() },
  user: { findUnique: jest.fn() },
  position: { findMany: jest.fn() },
  yieldSnapshot: { findMany: jest.fn() },
  transaction: {
    count: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
  },
  protocolRate: { findMany: jest.fn() },
  agentLog: { findFirst: jest.fn() },
};

jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: mockDb,
  db: mockDb,
}));

import request from 'supertest';
import app from '../../../src/index';

const USER_ID = '550e8400-e29b-41d4-a716-446655440002';
const TOKEN = 'tx-test-token';

const SESSION = {
  id: 'session-tx',
  userId: USER_ID,
  walletAddress: 'GABC_TX',
  network: 'TESTNET',
  expiresAt: new Date(Date.now() + 3_600_000),
  user: { id: USER_ID, isActive: true },
};

function makeTx(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tx-id-1',
    txHash: 'txhash-abc001',
    userId: USER_ID,
    type: 'DEPOSIT',
    status: 'CONFIRMED',
    amount: 100,
    assetSymbol: 'USDC',
    protocolName: 'Blend',
    createdAt: new Date(),
    ...overrides,
  };
}

function authHeader() {
  return { Authorization: `Bearer ${TOKEN}` };
}

describe('Transactions routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.session.findUnique.mockResolvedValue(SESSION);
    mockDb.user.findUnique.mockResolvedValue({ id: USER_ID });
    mockDb.transaction.count.mockResolvedValue(1);
    mockDb.transaction.findMany.mockResolvedValue([makeTx()]);
    mockDb.transaction.findUnique.mockResolvedValue(makeTx());
  });

  // ── GET /api/transactions/:userId ──────────────────────────────────────────

  describe('GET /api/transactions/:userId', () => {
    it('returns 401 without auth token', async () => {
      const res = await request(app).get(`/api/transactions/${USER_ID}`);
      expect(res.status).toBe(401);
    });

    it("returns 401 when requesting another user's transactions", async () => {
      const otherId = '550e8400-e29b-41d4-a716-999999999999';
      const res = await request(app)
        .get(`/api/transactions/${otherId}`)
        .set(authHeader());
      expect(res.status).toBe(401);
    });

    it('returns 404 when user does not exist', async () => {
      mockDb.user.findUnique.mockResolvedValue(null);
      const res = await request(app)
        .get(`/api/transactions/${USER_ID}`)
        .set(authHeader());
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('User not found');
    });

    it('returns 200 with the expected pagination shape', async () => {
      const res = await request(app)
        .get(`/api/transactions/${USER_ID}`)
        .set(authHeader());
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        page: expect.any(Number),
        limit: expect.any(Number),
        total: expect.any(Number),
        transactions: expect.any(Array),
        whatsappReply: expect.any(String),
      });
    });

    it('defaults to page=1 and limit=5', async () => {
      const res = await request(app)
        .get(`/api/transactions/${USER_ID}`)
        .set(authHeader());
      expect(res.status).toBe(200);
      expect(res.body.page).toBe(1);
      expect(res.body.limit).toBe(5);
      expect(mockDb.transaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 5, skip: 0 }),
      );
    });

    it('respects explicit page and limit query params', async () => {
      mockDb.transaction.count.mockResolvedValue(20);
      const res = await request(app)
        .get(`/api/transactions/${USER_ID}?page=2&limit=10`)
        .set(authHeader());
      expect(res.status).toBe(200);
      expect(res.body.page).toBe(2);
      expect(res.body.limit).toBe(10);
      expect(mockDb.transaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 10, skip: 10 }),
      );
    });

    it('returns 400 when page is not a number', async () => {
      const res = await request(app)
        .get(`/api/transactions/${USER_ID}?page=abc`)
        .set(authHeader());
      expect(res.status).toBe(400);
    });

    it('returns 400 when limit exceeds maximum (50)', async () => {
      const res = await request(app)
        .get(`/api/transactions/${USER_ID}?limit=100`)
        .set(authHeader());
      expect(res.status).toBe(400);
    });

    it('each transaction item has the required fields', async () => {
      const res = await request(app)
        .get(`/api/transactions/${USER_ID}`)
        .set(authHeader());
      const [tx] = res.body.transactions;
      expect(tx).toMatchObject({
        id: expect.any(String),
        txHash: expect.any(String),
        type: expect.any(String),
        status: expect.any(String),
        amount: expect.any(Number),
        assetSymbol: expect.any(String),
        createdAt: expect.any(String),
      });
    });

    it('orders transactions by createdAt desc', async () => {
      await request(app)
        .get(`/api/transactions/${USER_ID}`)
        .set(authHeader());
      expect(mockDb.transaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { createdAt: 'desc' } }),
      );
    });
  });

  // ── GET /api/transactions/detail/:txHash ──────────────────────────────────

  describe('GET /api/transactions/detail/:txHash', () => {
    it('returns 401 without auth token', async () => {
      const res = await request(app).get(
        '/api/transactions/detail/txhash-abc001',
      );
      expect(res.status).toBe(401);
    });

    it('returns 404 when transaction does not belong to this user', async () => {
      mockDb.transaction.findUnique.mockResolvedValue(
        makeTx({ userId: 'other-user' }),
      );
      const res = await request(app)
        .get('/api/transactions/detail/txhash-abc001')
        .set(authHeader());
      expect(res.status).toBe(404);
    });

    it('returns 404 when transaction is not found', async () => {
      mockDb.transaction.findUnique.mockResolvedValue(null);
      const res = await request(app)
        .get('/api/transactions/detail/txhash-notfound')
        .set(authHeader());
      expect(res.status).toBe(404);
    });

    it('returns 200 with transaction detail and whatsappReply', async () => {
      const res = await request(app)
        .get('/api/transactions/detail/txhash-abc001')
        .set(authHeader());
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        transaction: expect.objectContaining({
          txHash: 'txhash-abc001',
          type: 'DEPOSIT',
          status: 'CONFIRMED',
          amount: expect.any(Number),
        }),
        whatsappReply: expect.any(String),
      });
    });
  });
});
