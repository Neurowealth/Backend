/**
 * Auth system tests
 *
 * Covers:
 *  - Challenge endpoint
 *  - Verify endpoint (happy path, expired nonce, invalid signature, replay attack)
 *  - AuthMiddleware (missing token, invalid format, bad JWT, session not found, expired session, valid flow)
 *  - Logout endpoint
 *
 * Stellar signatures are produced with a real ephemeral keypair so we don't need
 * to hard-code any secret.  Prisma and the logger are mocked to avoid DB / I/O
 * dependencies in unit tests.
 */

import { Request, Response } from 'express';
import { Keypair } from '@stellar/stellar-sdk';

// Prisma mock
const mockPrisma = {
  user: {
    findUnique: jest.fn(),
    create: jest.fn(),
  },
  session: {
    findUnique: jest.fn(),
    create: jest.fn(),
    deleteMany: jest.fn(),
    delete: jest.fn(),
  },
};

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => mockPrisma),
  Network: { MAINNET: 'MAINNET', TESTNET: 'TESTNET' },
}));

// Logger mock
jest.mock('../../utils/logger', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

// JwtAdapter + config mock
jest.mock('../../config', () => ({
  JwtAdapter: {
    generateToken: jest.fn().mockResolvedValue('mock.jwt.token'),
    validateToken: jest.fn(),
  },
  config: {
    stellar: { network: 'testnet' },
    jwt: {
      seed: 'test-seed',
      session_ttl_hours: 24,
      nonce_ttl_ms: 300000,
      interval_ms: 86400000,
    },
  },
}));

// env config mock (used by stellar-verification)
jest.mock('../../config/env', () => ({
  config: {
    stellar: { network: 'testnet' },
    jwt: {
      seed: 'test-seed',
      session_ttl_hours: 24,
      nonce_ttl_ms: 300000,
      interval_ms: 86400000,
    },
  },
}));

// Import after mocks
import { challenge, verify, logout, _nonceStoreForTests } from '../../controllers/auth-controller';
import { AuthMiddleware } from '../../middleware/authenticate';
import { JwtAdapter } from '../../config';

// Helpers

function makeRes(): Response {
  const res: Partial<Response> = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res as Response;
}

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    body: {},
    header: jest.fn().mockReturnValue(undefined),
    headers: {},
    ip: '127.0.0.1',
    ...overrides,
  } as unknown as Request;
}

// Challenge endpoint

describe('POST /api/auth/challenge', () => {
  const keypair = Keypair.random();

  beforeEach(() => {
    _nonceStoreForTests.clear();
  });

  it('returns 400 when stellarPubKey is missing', async () => {
    const req = makeReq({ body: {} });
    const res = makeRes();
    await challenge(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }));
  });

  it('returns 400 for an invalid Stellar public key', async () => {
    const req = makeReq({ body: { stellarPubKey: 'not-a-valid-key' } });
    const res = makeRes();
    await challenge(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 200 with a nonce and expiresAt for a valid public key', async () => {
    const req = makeReq({ body: { stellarPubKey: keypair.publicKey() } });
    const res = makeRes();
    await challenge(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body).toHaveProperty('nonce');
    expect(body).toHaveProperty('expiresAt');
    expect(body.nonce).toMatch(/^nw-auth-/);
  });

  it('overwrites an existing nonce with a fresh one on a second call', async () => {
    const pubKey = keypair.publicKey();
    const req = makeReq({ body: { stellarPubKey: pubKey } });

    await challenge(req, makeRes());
    const first = _nonceStoreForTests.get(pubKey)?.nonce;

    await challenge(req, makeRes());
    const second = _nonceStoreForTests.get(pubKey)?.nonce;

    expect(first).not.toBe(second);
  });
});

// Verify endpoint

describe('POST /api/auth/verify', () => {
  const keypair = Keypair.random();
  const pubKey = keypair.publicKey();

  const mockUser = {
    id: 'user-uuid-1',
    walletAddress: pubKey,
    network: 'TESTNET',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    _nonceStoreForTests.clear();
    (JwtAdapter.generateToken as jest.Mock).mockResolvedValue('mock.jwt.token');
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.user.create.mockResolvedValue(mockUser);
    mockPrisma.session.create.mockResolvedValue({});
  });

  /** Seed the nonce store and return the signed nonce */
  function seedNonce(pubkey: string, kp: Keypair, ttlOffset = NONCE_TTL_MS_TEST): string {
    const nonce = `nw-auth-test-${Date.now()}`;
    _nonceStoreForTests.set(pubkey, {
      nonce,
      expiresAt: Date.now() + ttlOffset,
      stellarPubKey: pubkey,
    });
    return nonce;
  }

  const NONCE_TTL_MS_TEST = 5 * 60 * 1000;

  it('returns 400 when required fields are missing', async () => {
    const req = makeReq({ body: {} });
    const res = makeRes();
    await verify(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 401 when no active challenge exists for the public key', async () => {
    const sig = Buffer.from(keypair.sign(Buffer.from('irrelevant'))).toString('base64');
    const req = makeReq({ body: { stellarPubKey: pubKey, signature: sig } });
    const res = makeRes();
    await verify(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect((res.json as jest.Mock).mock.calls[0][0]).toMatchObject({
      error: expect.stringContaining('No active challenge'),
    });
  });

  it('returns 401 for an expired nonce', async () => {
    _nonceStoreForTests.set(pubKey, {
      nonce: 'old-nonce',
      expiresAt: Date.now() - 1, // already expired
      stellarPubKey: pubKey,
    });
    const sig = Buffer.from(keypair.sign(Buffer.from('old-nonce'))).toString('base64');
    const req = makeReq({ body: { stellarPubKey: pubKey, signature: sig } });
    const res = makeRes();
    await verify(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect((res.json as jest.Mock).mock.calls[0][0]).toMatchObject({
      error: expect.stringContaining('expired'),
    });
  });

  it('returns 401 for an invalid (tampered) signature', async () => {
    seedNonce(pubKey, keypair);
    const badSig = Buffer.from('tampered-signature-bytes').toString('base64');
    const req = makeReq({ body: { stellarPubKey: pubKey, signature: badSig } });
    const res = makeRes();
    await verify(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect((res.json as jest.Mock).mock.calls[0][0]).toMatchObject({
      error: 'Invalid signature',
    });
  });

  it('returns 200 with a token for a valid signature (happy path)', async () => {
    const nonce = seedNonce(pubKey, keypair);
    const sigBytes = keypair.sign(Buffer.from(nonce, 'utf8'));
    const sig = Buffer.from(sigBytes).toString('base64');

    const req = makeReq({ body: { stellarPubKey: pubKey, signature: sig } });
    const res = makeRes();
    await verify(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body).toHaveProperty('token', 'mock.jwt.token');
    expect(body).toHaveProperty('userId');
    expect(body).toHaveProperty('expiresAt');
  });

  it('prevents replay attack — second verify with same nonce returns 401', async () => {
    const nonce = seedNonce(pubKey, keypair);
    const sigBytes = keypair.sign(Buffer.from(nonce, 'utf8'));
    const sig = Buffer.from(sigBytes).toString('base64');

    // First call succeeds
    await verify(makeReq({ body: { stellarPubKey: pubKey, signature: sig } }), makeRes());

    // Second call with same public key — nonce was consumed
    const res2 = makeRes();
    await verify(makeReq({ body: { stellarPubKey: pubKey, signature: sig } }), res2);
    expect(res2.status).toHaveBeenCalledWith(401);
  });

  it('auto-creates a user when one does not exist', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);

    const nonce = seedNonce(pubKey, keypair);
    const sig = Buffer.from(keypair.sign(Buffer.from(nonce, 'utf8'))).toString('base64');

    await verify(makeReq({ body: { stellarPubKey: pubKey, signature: sig } }), makeRes());

    expect(mockPrisma.user.create).toHaveBeenCalledTimes(1);
  });

  it('does not create a duplicate user when one already exists', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(mockUser);

    const nonce = seedNonce(pubKey, keypair);
    const sig = Buffer.from(keypair.sign(Buffer.from(nonce, 'utf8'))).toString('base64');

    await verify(makeReq({ body: { stellarPubKey: pubKey, signature: sig } }), makeRes());

    expect(mockPrisma.user.create).not.toHaveBeenCalled();
  });
});

// AuthMiddleware

describe('AuthMiddleware.validateJwt', () => {
  const next = jest.fn();

  const mockSession = {
    token: 'valid.token',
    expiresAt: new Date(Date.now() + 60_000),
    walletAddress: 'GBTEST',
    user: { id: 'user-1', walletAddress: 'GBTEST' },
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 401 when Authorization header is missing', async () => {
    const req = makeReq({ header: jest.fn().mockReturnValue(undefined) });
    const res = makeRes();
    await AuthMiddleware.validateJwt(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when Authorization header does not start with "Bearer "', async () => {
    const req = makeReq({ header: jest.fn().mockReturnValue('Token abc123') });
    const res = makeRes();
    await AuthMiddleware.validateJwt(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when JWT signature is invalid', async () => {
    (JwtAdapter.validateToken as jest.Mock).mockResolvedValue(null);
    const req = makeReq({ header: jest.fn().mockReturnValue('Bearer bad.token') });
    const res = makeRes();
    await AuthMiddleware.validateJwt(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when session is not found in the database', async () => {
    (JwtAdapter.validateToken as jest.Mock).mockResolvedValue({ id: 'user-1' });
    mockPrisma.session.findUnique.mockResolvedValue(null);

    const req = makeReq({ header: jest.fn().mockReturnValue('Bearer valid.jwt') });
    const res = makeRes();
    await AuthMiddleware.validateJwt(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect((res.json as jest.Mock).mock.calls[0][0]).toMatchObject({ error: 'Session not found' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 and deletes the record when the session is expired', async () => {
    (JwtAdapter.validateToken as jest.Mock).mockResolvedValue({ id: 'user-1' });
    mockPrisma.session.findUnique.mockResolvedValue({
      ...mockSession,
      expiresAt: new Date(Date.now() - 1000), // expired
    });
    mockPrisma.session.delete.mockResolvedValue({});

    const req = makeReq({ header: jest.fn().mockReturnValue('Bearer expired.token') });
    const res = makeRes();
    await AuthMiddleware.validateJwt(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect((res.json as jest.Mock).mock.calls[0][0]).toMatchObject({ error: 'Session expired' });
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() and attaches userId + stellarPubKey for a valid token', async () => {
    (JwtAdapter.validateToken as jest.Mock).mockResolvedValue({ id: 'user-1' });
    mockPrisma.session.findUnique.mockResolvedValue(mockSession);

    const req = makeReq({ header: jest.fn().mockReturnValue('Bearer valid.token') });
    const res = makeRes();
    await AuthMiddleware.validateJwt(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.userId).toBe('user-1');
    expect(req.stellarPubKey).toBe('GBTEST');
  });
});

// Logout endpoint

describe('POST /api/auth/logout', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.session.deleteMany.mockResolvedValue({ count: 1 });
  });

  it('deletes the session and returns 200', async () => {
    const req = makeReq({
      header: jest.fn().mockReturnValue('Bearer valid.token'),
      userId: 'user-1',
    });
    const res = makeRes();
    await logout(req, res);

    expect(mockPrisma.session.deleteMany).toHaveBeenCalledWith({
      where: { token: 'valid.token' },
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect((res.json as jest.Mock).mock.calls[0][0]).toMatchObject({
      message: 'Logged out successfully',
    });
  });
});
