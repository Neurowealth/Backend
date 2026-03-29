/**
 * Integration tests — Deposit API route
 *
 * Tests POST /api/deposit
 * Prisma is mocked; no real database is used.
 */

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

const mockDeposit = jest.fn();

jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: mockDb,
  db: mockDb,
}));

jest.mock('../../../src/stellar/contract', () => ({
  deposit: (...args: unknown[]) => mockDeposit(...args),
  depositForUser: (...args: unknown[]) => mockDeposit(...args),
  withdraw: jest.fn(),
  withdrawForUser: jest.fn(),
  getOnChainBalance: jest.fn(),
  getOnChainAPY: jest.fn(),
  getActiveProtocol: jest.fn(),
}));

import request from 'supertest';
import app from '../../../src/index';

const USER_ID = '550e8400-e29b-41d4-a716-446655440003';
const TOKEN = 'deposit-test-token';

const SESSION = {
  id: 'session-deposit',
  userId: USER_ID,
  walletAddress: 'GABC_DEPOSIT',
  network: 'TESTNET',
  expiresAt: new Date(Date.now() + 3_600_000),
  user: { id: USER_ID, isActive: true },
};

const VALID_DEPOSIT = {
  userId: USER_ID,
  amount: 100,
  assetSymbol: 'USDC',
  protocolName: 'Blend',
};

function authHeader() {
  return { Authorization: `Bearer ${TOKEN}` };
}

describe('Deposit route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.session.findUnique.mockResolvedValue(SESSION);
    mockDb.user.findUnique.mockResolvedValue({ id: USER_ID, network: 'TESTNET' });
    mockDb.transaction.findUnique.mockResolvedValue(null);
    mockDeposit.mockResolvedValue({
      hash: 'chain-hash-0000000001',
      status: 'success',
      ledger: 101,
    });
    mockDb.transaction.create.mockResolvedValue({
      id: 'tx-new',
      txHash: 'chain-hash-0000000001',
      status: 'CONFIRMED',
      amount: VALID_DEPOSIT.amount,
      assetSymbol: VALID_DEPOSIT.assetSymbol,
      protocolName: VALID_DEPOSIT.protocolName,
    });
  });

  // ── Authentication ────────────────────────────────────────────────────────

  it('returns 401 without auth token', async () => {
    const res = await request(app).post('/api/deposit').send(VALID_DEPOSIT);
    expect(res.status).toBe(401);
  });

  it('returns 401 when token has no active session', async () => {
    mockDb.session.findUnique.mockResolvedValue(null);
    const res = await request(app)
      .post('/api/deposit')
      .set(authHeader())
      .send(VALID_DEPOSIT);
    expect(res.status).toBe(401);
  });

  it('returns 401 when userId in body does not match authenticated user', async () => {
    const res = await request(app)
      .post('/api/deposit')
      .set(authHeader())
      .send({ ...VALID_DEPOSIT, userId: '550e8400-e29b-41d4-a716-999999999999' });
    expect(res.status).toBe(401);
  });

  // ── Validation ────────────────────────────────────────────────────────────

  it('returns 400 when userId is missing', async () => {
    const { userId, ...body } = VALID_DEPOSIT;
    const res = await request(app)
      .post('/api/deposit')
      .set(authHeader())
      .send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation error');
  });

  it('returns 400 when userId is not a valid UUID', async () => {
    const res = await request(app)
      .post('/api/deposit')
      .set(authHeader())
      .send({ ...VALID_DEPOSIT, userId: 'not-a-uuid' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when amount is zero or negative', async () => {
    const res = await request(app)
      .post('/api/deposit')
      .set(authHeader())
      .send({ ...VALID_DEPOSIT, amount: -10 });
    expect(res.status).toBe(400);
  });

  it('returns 400 when assetSymbol is missing', async () => {
    const { assetSymbol, ...body } = VALID_DEPOSIT;
    const res = await request(app)
      .post('/api/deposit')
      .set(authHeader())
      .send(body);
    expect(res.status).toBe(400);
  });

  // ── Business logic ────────────────────────────────────────────────────────

  it('returns 404 when user does not exist in DB', async () => {
    mockDb.user.findUnique.mockResolvedValue(null);
    const res = await request(app)
      .post('/api/deposit')
      .set(authHeader())
      .send(VALID_DEPOSIT);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('User not found');
  });

  it('returns 409 for a duplicate transaction hash', async () => {
    mockDb.transaction.findUnique.mockResolvedValue({ id: 'existing-tx' });
    const res = await request(app)
      .post('/api/deposit')
      .set(authHeader())
      .send(VALID_DEPOSIT);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Duplicate transaction hash');
  });

  // ── Successful deposit ────────────────────────────────────────────────────

  it('returns 201 with transaction data on success', async () => {
    const res = await request(app)
      .post('/api/deposit')
      .set(authHeader())
      .send(VALID_DEPOSIT);
    expect(res.status).toBe(201);
    expect(res.body.transaction).toMatchObject({
      txHash: 'chain-hash-0000000001',
      status: 'CONFIRMED',
      amount: VALID_DEPOSIT.amount,
      assetSymbol: VALID_DEPOSIT.assetSymbol,
    });
    expect(res.body.txHash).toBe('chain-hash-0000000001');
    expect(res.body.status).toBe('CONFIRMED');
  });

  it('returns a whatsappReply string on success', async () => {
    const res = await request(app)
      .post('/api/deposit')
      .set(authHeader())
      .send(VALID_DEPOSIT);
    expect(res.status).toBe(201);
    expect(typeof res.body.whatsappReply).toBe('string');
    expect(res.body.whatsappReply.length).toBeGreaterThan(0);
  });

  it('creates a confirmed transaction record with the on-chain hash', async () => {
    await request(app)
      .post('/api/deposit')
      .set(authHeader())
      .send(VALID_DEPOSIT);
    expect(mockDeposit).toHaveBeenCalledWith(
      USER_ID,
      SESSION.walletAddress,
      VALID_DEPOSIT.amount,
    );
    expect(mockDb.transaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'DEPOSIT',
          status: 'CONFIRMED',
          userId: USER_ID,
          txHash: 'chain-hash-0000000001',
          confirmedAt: expect.any(Date),
        }),
      }),
    );
  });

  it('accepts a deposit without optional protocolName and memo', async () => {
    const { protocolName, ...body } = VALID_DEPOSIT;
    const res = await request(app)
      .post('/api/deposit')
      .set(authHeader())
      .send(body);
    expect(res.status).toBe(201);
  });
});
