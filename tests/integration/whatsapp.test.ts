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
import * as userManager from '../../src/whatsapp/userManager';
import twilio from 'twilio';
import { Server } from 'http';

// Mock db with the shape the app expects (Prisma-style client).
// Defined BEFORE jest.mock so the factory can reference it.
const mockDb = {
  transaction: {
    create: jest.fn(),
  },
  $disconnect: jest.fn().mockResolvedValue(undefined),
};

jest.mock('../../src/whatsapp/userManager');
jest.mock('../../src/db', () => mockDb);
jest.mock('twilio');

// Helper: TwiML responses look like:
//   <?xml ...><Response><Message>some text here</Message></Response>
// Extract the inner text of the first <Message> tag.
function getTwimlMessage(responseText: string): string {
  const match = responseText.match(/<Message[^>]*>([\s\S]*?)<\/Message>/i);
  return match ? match[1].trim() : responseText;
}

describe('WhatsApp webhook integration', () => {
  const samplePhone = '+15551234567';
  let server: Server;

  beforeAll((done) => {
    server = app.listen(0, done);
  });

  afterAll(async () => {
    // Close the HTTP server
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });

    // Drain any remaining async handles
    await new Promise((resolve) => setImmediate(resolve));
  });

  beforeEach(() => {
    jest.resetAllMocks();
    // Re-stub after resetAllMocks wipes mockDb's jest.fn() implementations
    mockDb.$disconnect.mockResolvedValue(undefined);
    mockDb.transaction.create.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('GET health check returns 200', async () => {
    const resp = await request(server).get('/api/whatsapp/webhook');
    expect(resp.status).toBe(200);
    expect(resp.text).toBe('OK');
  });

  it('rejects invalid signature', async () => {
    (twilio.validateRequest as jest.Mock).mockReturnValue(false);
    const resp = await request(server)
      .post('/api/whatsapp/webhook')
      .type('form')
      .send({ From: `whatsapp:${samplePhone}`, Body: 'foo' });
    expect(resp.status).toBe(403);
  });

  it('new user gets OTP message', async () => {
    (twilio.validateRequest as jest.Mock).mockReturnValue(true);
    (userManager.getOrCreateUser as jest.Mock).mockResolvedValue({
      id: 'u1',
      phoneNumber: samplePhone,
      walletAddress: 'GABC',
      isActive: false,
    });
    (userManager.generateAndSaveOtp as jest.Mock).mockResolvedValue('123456');

    const resp = await request(server)
      .post('/api/whatsapp/webhook')
      .type('form')
      .send({ From: `whatsapp:${samplePhone}`, Body: 'hello' });

    expect(resp.status).toBe(200);
    expect(getTwimlMessage(resp.text)).toContain('123456');
    expect(userManager.generateAndSaveOtp).toHaveBeenCalledWith(samplePhone);
  });

  it('OTP verification works and returns active message', async () => {
    (twilio.validateRequest as jest.Mock).mockReturnValue(true);
    (userManager.getOrCreateUser as jest.Mock).mockResolvedValue({
      id: 'u1',
      phoneNumber: samplePhone,
      walletAddress: 'GABC',
      isActive: false,
    });
    (userManager.verifyOtpCode as jest.Mock).mockResolvedValue(true);

    const resp = await request(server)
      .post('/api/whatsapp/webhook')
      .type('form')
      .send({ From: `whatsapp:${samplePhone}`, Body: '123456' });

    expect(resp.status).toBe(200);
    expect(getTwimlMessage(resp.text)).toContain('verified');
  });

  it('wrong OTP triggers resend', async () => {
    (twilio.validateRequest as jest.Mock).mockReturnValue(true);
    (userManager.getOrCreateUser as jest.Mock).mockResolvedValue({
      id: 'u1',
      phoneNumber: samplePhone,
      walletAddress: 'GABC',
      isActive: false,
    });
    (userManager.verifyOtpCode as jest.Mock).mockResolvedValue(false);
    (userManager.generateAndSaveOtp as jest.Mock).mockResolvedValue('654321');

    const resp = await request(server)
      .post('/api/whatsapp/webhook')
      .type('form')
      .send({ From: `whatsapp:${samplePhone}`, Body: '000000' });

    expect(resp.status).toBe(200);
    const msg = getTwimlMessage(resp.text);
    expect(msg).toContain('new OTP');
    expect(msg).toContain('654321');
  });

  it('balance query for active user', async () => {
    (twilio.validateRequest as jest.Mock).mockReturnValue(true);
    (userManager.getOrCreateUser as jest.Mock).mockResolvedValue({
      id: 'u1',
      phoneNumber: samplePhone,
      walletAddress: 'GABC',
      isActive: true,
      network: 'TESTNET',
    });
    (userManager.calculateBalance as jest.Mock).mockResolvedValue(42);

    const resp = await request(server)
      .post('/api/whatsapp/webhook')
      .type('form')
      .send({ From: `whatsapp:${samplePhone}`, Body: 'balance' });

    expect(resp.status).toBe(200);
    expect(getTwimlMessage(resp.text)).toContain('42');
  });

  it('deposit flow creates pending transaction', async () => {
    (twilio.validateRequest as jest.Mock).mockReturnValue(true);
    (userManager.getOrCreateUser as jest.Mock).mockResolvedValue({
      id: 'u1',
      phoneNumber: samplePhone,
      walletAddress: 'GABC',
      isActive: true,
      network: 'TESTNET',
    });
    mockDb.transaction.create.mockResolvedValue({});

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

  it('withdraw flow with insufficient balance returns message', async () => {
    (twilio.validateRequest as jest.Mock).mockReturnValue(true);
    (userManager.getOrCreateUser as jest.Mock).mockResolvedValue({
      id: 'u1',
      phoneNumber: samplePhone,
      walletAddress: 'GABC',
      isActive: true,
      network: 'TESTNET',
    });
    (userManager.calculateBalance as jest.Mock).mockResolvedValue(50);

    const resp = await request(server)
      .post('/api/whatsapp/webhook')
      .type('form')
      .send({ From: `whatsapp:${samplePhone}`, Body: 'withdraw 100' });

    expect(resp.status).toBe(200);
    expect(getTwimlMessage(resp.text)).toMatch(/only have/);
  });

  it('withdraw all creates pending transaction', async () => {
    (twilio.validateRequest as jest.Mock).mockReturnValue(true);
    (userManager.getOrCreateUser as jest.Mock).mockResolvedValue({
      id: 'u1',
      phoneNumber: samplePhone,
      walletAddress: 'GABC',
      isActive: true,
      network: 'TESTNET',
    });
    (userManager.calculateBalance as jest.Mock).mockResolvedValue(123);
    mockDb.transaction.create.mockResolvedValue({});

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
