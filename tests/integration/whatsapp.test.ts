// populate env vars used by src/config/env.ts before any imports
process.env.STELLAR_NETWORK = 'TESTNET';
process.env.STELLAR_RPC_URL = 'http://localhost';
process.env.STELLAR_AGENT_SECRET = 'SOMETHING';
process.env.AGENT_SECRET_KEY = 'dummy';
process.env.VAULT_CONTRACT_ID = 'vault';
process.env.USDC_TOKEN_ADDRESS = 'usdc';
process.env.ANTHROPIC_API_KEY = 'fake';
process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/db';
process.env.TWILIO_AUTH_TOKEN = 'test-token';

import request from 'supertest';
import app from '../../src/index';
import twilio from 'twilio';
import { Server } from 'http';

// ---------------------------------------------------------------------------
// userManager mock
//
// src/whatsapp/userManager.ts has BOTH named exports AND a default export
// that is a plain object referencing those same functions.
// src/whatsapp/handler.ts imports the DEFAULT:
//   import userManager from './userManager';
//   userManager.getOrCreateUser(...)
//
// To intercept the default-export calls we must mock the module so that the
// default export object's methods are jest.fn()s we can control.
// ---------------------------------------------------------------------------
const mockUserManager = {
  getOrCreateUser: jest.fn(),
  generateAndSaveOtp: jest.fn(),
  verifyOtpCode: jest.fn(),
  getUserByPhone: jest.fn(),
  calculateBalance: jest.fn(),
};

jest.mock('../../src/whatsapp/userManager', () => ({
  // named exports (used nowhere in the handler, but keep parity)
  getOrCreateUser: mockUserManager.getOrCreateUser,
  generateAndSaveOtp: mockUserManager.generateAndSaveOtp,
  verifyOtpCode: mockUserManager.verifyOtpCode,
  getUserByPhone: mockUserManager.getUserByPhone,
  calculateBalance: mockUserManager.calculateBalance,
  // default export – this is what handler.ts actually calls
  default: mockUserManager,
  __esModule: true,
}));

// ---------------------------------------------------------------------------
// db mock  (Prisma-style client)
// ---------------------------------------------------------------------------
const mockDb = {
  transaction: {
    create: jest.fn(),
  },
  user: {
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  $disconnect: jest.fn().mockResolvedValue(undefined),
};

jest.mock('../../src/db', () => ({ default: mockDb, __esModule: true }));

jest.mock('twilio');

// ---------------------------------------------------------------------------
// Helper: TwiML responses look like:
//   <?xml ...><Response><Message>text here</Message></Response>
// Extract the inner text of the first <Message> tag.
// ---------------------------------------------------------------------------
function getTwimlMessage(responseText: string): string {
  const match = responseText.match(/<Message[^>]*>([\s\S]*?)<\/Message>/i);
  return match ? match[1].trim() : responseText;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
describe('WhatsApp webhook integration', () => {
  const samplePhone = '+15551234567';
  let server: Server;

  beforeAll((done) => {
    server = app.listen(0, done);
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await new Promise((resolve) => setImmediate(resolve));
  });

  beforeEach(() => {
    jest.resetAllMocks();
    // Restore default resolved values after resetAllMocks clears them
    mockDb.$disconnect.mockResolvedValue(undefined);
    mockDb.transaction.create.mockResolvedValue({});
    mockDb.user.findUnique.mockResolvedValue(null);
    mockDb.user.create.mockResolvedValue({});
    mockDb.user.update.mockResolvedValue({});
  });

  afterEach(async () => {
    await new Promise((resolve) => setImmediate(resolve));
  });

  // -------------------------------------------------------------------------
  it('GET health check returns 200', async () => {
    const resp = await request(server).get('/api/whatsapp/webhook');
    expect(resp.status).toBe(200);
    expect(resp.text).toBe('OK');
  });

  // -------------------------------------------------------------------------
  it('rejects invalid signature', async () => {
    (twilio.validateRequest as jest.Mock).mockReturnValue(false);
    const resp = await request(server)
      .post('/api/whatsapp/webhook')
      .type('form')
      .send({ From: `whatsapp:${samplePhone}`, Body: 'foo' });
    expect(resp.status).toBe(403);
  });

  // -------------------------------------------------------------------------
  it('new user gets OTP message', async () => {
    (twilio.validateRequest as jest.Mock).mockReturnValue(true);
    mockUserManager.getOrCreateUser.mockResolvedValue({
      id: 'u1',
      phoneNumber: samplePhone,
      walletAddress: 'GABC',
      isActive: false,
    });
    mockUserManager.generateAndSaveOtp.mockResolvedValue('123456');

    const resp = await request(server)
      .post('/api/whatsapp/webhook')
      .type('form')
      .send({ From: `whatsapp:${samplePhone}`, Body: 'hello' });

    expect(resp.status).toBe(200);
    expect(getTwimlMessage(resp.text)).toContain('123456');
    expect(mockUserManager.generateAndSaveOtp).toHaveBeenCalledWith(samplePhone);
  });

  // -------------------------------------------------------------------------
  it('OTP verification works and returns active message', async () => {
    (twilio.validateRequest as jest.Mock).mockReturnValue(true);
    mockUserManager.getOrCreateUser.mockResolvedValue({
      id: 'u1',
      phoneNumber: samplePhone,
      walletAddress: 'GABC',
      isActive: false,
    });
    mockUserManager.verifyOtpCode.mockResolvedValue(true);

    const resp = await request(server)
      .post('/api/whatsapp/webhook')
      .type('form')
      .send({ From: `whatsapp:${samplePhone}`, Body: '123456' });

    expect(resp.status).toBe(200);
    expect(getTwimlMessage(resp.text)).toContain('verified');
  });

  // -------------------------------------------------------------------------
  it('wrong OTP triggers resend', async () => {
    (twilio.validateRequest as jest.Mock).mockReturnValue(true);
    mockUserManager.getOrCreateUser.mockResolvedValue({
      id: 'u1',
      phoneNumber: samplePhone,
      walletAddress: 'GABC',
      isActive: false,
    });
    mockUserManager.verifyOtpCode.mockResolvedValue(false);
    mockUserManager.generateAndSaveOtp.mockResolvedValue('654321');

    const resp = await request(server)
      .post('/api/whatsapp/webhook')
      .type('form')
      .send({ From: `whatsapp:${samplePhone}`, Body: '000000' });

    expect(resp.status).toBe(200);
    const msg = getTwimlMessage(resp.text);
    expect(msg).toContain('new OTP');
    expect(msg).toContain('654321');
  });

  // -------------------------------------------------------------------------
  it('balance query for active user', async () => {
    (twilio.validateRequest as jest.Mock).mockReturnValue(true);
    mockUserManager.getOrCreateUser.mockResolvedValue({
      id: 'u1',
      phoneNumber: samplePhone,
      walletAddress: 'GABC',
      isActive: true,
      network: 'TESTNET',
    });
    mockUserManager.calculateBalance.mockResolvedValue(42);

    const resp = await request(server)
      .post('/api/whatsapp/webhook')
      .type('form')
      .send({ From: `whatsapp:${samplePhone}`, Body: 'balance' });

    expect(resp.status).toBe(200);
    expect(getTwimlMessage(resp.text)).toContain('42');
  });

  // -------------------------------------------------------------------------
  it('deposit flow creates pending transaction', async () => {
    (twilio.validateRequest as jest.Mock).mockReturnValue(true);
    mockUserManager.getOrCreateUser.mockResolvedValue({
      id: 'u1',
      phoneNumber: samplePhone,
      walletAddress: 'GABC',
      isActive: true,
      network: 'TESTNET',
    });

    const resp = await request(server)
      .post('/api/whatsapp/webhook')
      .type('form')
      .send({ From: `whatsapp:${samplePhone}`, Body: 'deposit 100' });

    expect(resp.status).toBe(200);
    expect(getTwimlMessage(resp.text)).toMatch(/To deposit/);
    expect(mockDb.transaction.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ type: 'DEPOSIT', amount: 100 }),
    }));
  });

  // -------------------------------------------------------------------------
  it('withdraw flow with insufficient balance returns message', async () => {
    (twilio.validateRequest as jest.Mock).mockReturnValue(true);
    mockUserManager.getOrCreateUser.mockResolvedValue({
      id: 'u1',
      phoneNumber: samplePhone,
      walletAddress: 'GABC',
      isActive: true,
      network: 'TESTNET',
    });
    mockUserManager.calculateBalance.mockResolvedValue(50);

    const resp = await request(server)
      .post('/api/whatsapp/webhook')
      .type('form')
      .send({ From: `whatsapp:${samplePhone}`, Body: 'withdraw 100' });

    expect(resp.status).toBe(200);
    expect(getTwimlMessage(resp.text)).toMatch(/only have/);
  });

  // -------------------------------------------------------------------------
  it('withdraw all creates pending transaction', async () => {
    (twilio.validateRequest as jest.Mock).mockReturnValue(true);
    mockUserManager.getOrCreateUser.mockResolvedValue({
      id: 'u1',
      phoneNumber: samplePhone,
      walletAddress: 'GABC',
      isActive: true,
      network: 'TESTNET',
    });
    mockUserManager.calculateBalance.mockResolvedValue(123);

    const resp = await request(server)
      .post('/api/whatsapp/webhook')
      .type('form')
      .send({ From: `whatsapp:${samplePhone}`, Body: 'withdraw all' });

    expect(resp.status).toBe(200);
    expect(getTwimlMessage(resp.text)).toMatch(/withdraw all/);
    expect(mockDb.transaction.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ type: 'WITHDRAWAL', amount: 123 }),
    }));
  });
});
