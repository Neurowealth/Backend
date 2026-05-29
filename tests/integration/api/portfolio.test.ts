/**
 * Integration tests — Portfolio API routes
 *
 * Tests /api/portfolio/:userId, /:userId/history, /:userId/earnings
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
  transaction: { count: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn() },
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

const USER_ID = '550e8400-e29b-41d4-a716-446655440001';
const TOKEN = 'portfolio-test-token';

const SESSION = {
  id: 'session-portfolio',
  userId: USER_ID,
  walletAddress: 'GABC_PORTFOLIO',
  network: 'TESTNET',
  expiresAt: new Date(Date.now() + 3_600_000),
  user: { id: USER_ID, isActive: true },
};

const POSITIONS = [
  {
    id: 'pos-1',
    protocolName: 'Blend',
    assetSymbol: 'USDC',
    currentValue: 5200,
    yieldEarned: 200,
    status: 'ACTIVE',
  },
  {
    id: 'pos-2',
    protocolName: 'Luma',
    assetSymbol: 'USDC',
    currentValue: 3000,
    yieldEarned: 100,
    status: 'CLOSED',
  },
];

// ─── helpers ─────────────────────────────────────────────────────────────────

function authHeader() {
  return { Authorization: `Bearer ${TOKEN}` };
}

describe('Portfolio routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.session.findUnique.mockResolvedValue(SESSION);
    mockDb.user.findUnique.mockResolvedValue({ id: USER_ID });
    mockDb.position.findMany.mockResolvedValue(POSITIONS);
    mockDb.yieldSnapshot.findMany.mockResolvedValue([]);
  });

  // ── GET /api/portfolio/:userId ────────────────────────────────────────────

  describe('GET /api/portfolio/:userId', () => {
    it('returns 401 when no Authorization header is provided', async () => {
      const res = await request(app).get(`/api/portfolio/${USER_ID}`);
      expect(res.status).toBe(401);
    });

    it('returns 401 when token has no active session', async () => {
      mockDb.session.findUnique.mockResolvedValue(null);
      const res = await request(app)
        .get(`/api/portfolio/${USER_ID}`)
        .set(authHeader());
      expect(res.status).toBe(401);
    });

    it("returns 401 when requesting a different user's portfolio", async () => {
      const differentUserId = '550e8400-e29b-41d4-a716-999999999999';
      const res = await request(app)
        .get(`/api/portfolio/${differentUserId}`)
        .set(authHeader());
      expect(res.status).toBe(401);
    });

    it('returns 404 when user does not exist', async () => {
      mockDb.user.findUnique.mockResolvedValue(null);
      const res = await request(app)
        .get(`/api/portfolio/${USER_ID}`)
        .set(authHeader());
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('User not found');
    });

    it('returns 200 with the expected portfolio shape', async () => {
      const res = await request(app)
        .get(`/api/portfolio/${USER_ID}`)
        .set(authHeader());
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        userId: USER_ID,
        totalBalance: 8200,
        totalEarnings: 300,
        activePositions: 1,
        positions: expect.any(Array),
        whatsappReply: expect.any(String),
      });
    });

    it('positions array contains correct fields', async () => {
      const res = await request(app)
        .get(`/api/portfolio/${USER_ID}`)
        .set(authHeader());
      const { positions } = res.body;
      expect(positions).toHaveLength(2);
      expect(positions[0]).toMatchObject({
        id: expect.any(String),
        protocolName: expect.any(String),
        assetSymbol: expect.any(String),
        currentValue: expect.any(Number),
        yieldEarned: expect.any(Number),
        status: expect.any(String),
      });
    });

    it('returns empty positions list when user has no positions', async () => {
      mockDb.position.findMany.mockResolvedValue([]);
      const res = await request(app)
        .get(`/api/portfolio/${USER_ID}`)
        .set(authHeader());
      expect(res.status).toBe(200);
      expect(res.body.totalBalance).toBe(0);
      expect(res.body.totalEarnings).toBe(0);
      expect(res.body.activePositions).toBe(0);
    });
  });

  // ── GET /api/portfolio/:userId/history ────────────────────────────────────

  describe('GET /api/portfolio/:userId/history', () => {
    const SNAPSHOTS = [
      { snapshotAt: new Date('2026-02-01'), yieldAmount: 5 },
      { snapshotAt: new Date('2026-01-15'), yieldAmount: 4 },
    ];

    beforeEach(() => {
      mockDb.yieldSnapshot.findMany.mockResolvedValue(SNAPSHOTS);
    });

    it('returns 401 without auth token', async () => {
      const res = await request(app).get(
        `/api/portfolio/${USER_ID}/history`,
      );
      expect(res.status).toBe(401);
    });

    it('returns 200 with period and points', async () => {
      const res = await request(app)
        .get(`/api/portfolio/${USER_ID}/history?period=30d`)
        .set(authHeader());
      expect(res.status).toBe(200);
      expect(res.body.period).toBe('30d');
      expect(res.body.points).toHaveLength(2);
    });

    it('defaults to 30d when period is not specified', async () => {
      const res = await request(app)
        .get(`/api/portfolio/${USER_ID}/history`)
        .set(authHeader());
      expect(res.status).toBe(200);
      expect(res.body.period).toBe('30d');
    });

    it('returns 400 for an invalid period value', async () => {
      const res = await request(app)
        .get(`/api/portfolio/${USER_ID}/history?period=999d`)
        .set(authHeader());
      expect(res.status).toBe(400);
    });

    it('accepts period=7d', async () => {
      const res = await request(app)
        .get(`/api/portfolio/${USER_ID}/history?period=7d`)
        .set(authHeader());
      expect(res.status).toBe(200);
      expect(res.body.period).toBe('7d');
    });

    it('accepts period=90d', async () => {
      const res = await request(app)
        .get(`/api/portfolio/${USER_ID}/history?period=90d`)
        .set(authHeader());
      expect(res.status).toBe(200);
      expect(res.body.period).toBe('90d');
    });

    it('returns 404 when user does not exist', async () => {
      mockDb.user.findUnique.mockResolvedValue(null);
      const res = await request(app)
        .get(`/api/portfolio/${USER_ID}/history`)
        .set(authHeader());
      expect(res.status).toBe(404);
    });
  });

  // ── GET /api/portfolio/:userId/earnings ───────────────────────────────────

  describe('GET /api/portfolio/:userId/earnings', () => {
    const SNAPSHOTS = [
      { apy: 4.25, yieldAmount: 10, snapshotAt: new Date() },
      { apy: 3.80, yieldAmount: 8, snapshotAt: new Date() },
    ];

    beforeEach(() => {
      mockDb.yieldSnapshot.findMany.mockResolvedValue(SNAPSHOTS);
    });

    it('returns 401 without auth token', async () => {
      const res = await request(app).get(
        `/api/portfolio/${USER_ID}/earnings`,
      );
      expect(res.status).toBe(401);
    });

    it('returns 200 with earnings shape', async () => {
      const res = await request(app)
        .get(`/api/portfolio/${USER_ID}/earnings`)
        .set(authHeader());
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        userId: USER_ID,
        totalEarnings: expect.any(Number),
        periodEarnings: expect.any(Number),
        averageApy: expect.any(Number),
        whatsappReply: expect.any(String),
      });
    });

    it('calculates averageApy correctly', async () => {
      const res = await request(app)
        .get(`/api/portfolio/${USER_ID}/earnings`)
        .set(authHeader());
      // (4.25 + 3.80) / 2 = 4.025
      expect(res.body.averageApy).toBeCloseTo(4.025);
    });

    it('returns 404 when user does not exist', async () => {
      mockDb.user.findUnique.mockResolvedValue(null);
      const res = await request(app)
        .get(`/api/portfolio/${USER_ID}/earnings`)
        .set(authHeader());
      expect(res.status).toBe(404);
    });
  });
});
