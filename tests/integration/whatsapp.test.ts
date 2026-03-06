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
import db from '../../src/db';
import twilio from 'twilio';

jest.mock('../../src/whatsapp/userManager');
jest.mock('../../src/db');
jest.mock('twilio');

describe('WhatsApp webhook integration', () => {
  const samplePhone = '+15551234567';

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('GET health check returns 200', async () => {
    const resp = await request(app).get('/api/whatsapp/webhook');
    expect(resp.status).toBe(200);
    expect(resp.text).toBe('OK');
  });

  it('rejects invalid signature', async () => {
    (twilio.validateRequest as jest.Mock).mockReturnValue(false);
    const resp = await request(app)
      .post('/api/whatsapp/webhook')
      .type('form')
      .send({ From: `whatsapp:${samplePhone}`, Body: 'foo' });
    expect(resp.status).toBe(403);
  });

  it('new user gets OTP message', async () => {
    (twilio.validateRequest as jest.Mock).mockReturnValue(true);
    // no existing user; getOrCreate will create and return isActive=false
    (userManager.getOrCreateUser as jest.Mock).mockResolvedValue({
      id: 'u1',
      phoneNumber: samplePhone,
      walletAddress: 'GABC',
      isActive: false,
    });
    (userManager.generateAndSaveOtp as jest.Mock).mockResolvedValue('123456');

    const resp = await request(app)
      .post('/api/whatsapp/webhook')
      .type('form')
      .send({ From: `whatsapp:${samplePhone}`, Body: 'hello' });

    expect(resp.status).toBe(200);
    expect(resp.text).toContain('123456');
    expect(userManager.generateAndSaveOtp).toHaveBeenCalledWith(samplePhone);
  });

  it('OTP verification works and returns active message', async () => {
    (twilio.validateRequest as jest.Mock).mockReturnValue(true);
    // simulate existing not active user
    (userManager.getOrCreateUser as jest.Mock).mockResolvedValue({
      id: 'u1',
      phoneNumber: samplePhone,
      walletAddress: 'GABC',
      isActive: false,
    });
    (userManager.verifyOtpCode as jest.Mock).mockResolvedValue(true);

    // send 6-digit code
    const resp = await request(app)
      .post('/api/whatsapp/webhook')
      .type('form')
      .send({ From: `whatsapp:${samplePhone}`, Body: '123456' });

    expect(resp.status).toBe(200);
    expect(resp.text).toContain('verified');
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

    const resp = await request(app)
      .post('/api/whatsapp/webhook')
      .type('form')
      .send({ From: `whatsapp:${samplePhone}`, Body: '000000' });

    expect(resp.status).toBe(200);
    expect(resp.text).toContain('new OTP');
    expect(resp.text).toContain('654321');
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

    const resp = await request(app)
      .post('/api/whatsapp/webhook')
      .type('form')
      .send({ From: `whatsapp:${samplePhone}`, Body: 'balance' });

    expect(resp.status).toBe(200);
    expect(resp.text).toContain('42');
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

    (db.transaction.create as jest.Mock).mockResolvedValue({});

    const resp = await request(app)
      .post('/api/whatsapp/webhook')
      .type('form')
      .send({ From: `whatsapp:${samplePhone}`, Body: 'deposit 100' });

    expect(resp.status).toBe(200);
    expect(resp.text).toMatch(/To deposit/);
    expect(db.transaction.create).toHaveBeenCalledWith(expect.objectContaining({
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

    const resp = await request(app)
      .post('/api/whatsapp/webhook')
      .type('form')
      .send({ From: `whatsapp:${samplePhone}`, Body: 'withdraw 100' });

    expect(resp.status).toBe(200);
    expect(resp.text).toMatch(/only have/);
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
    (db.transaction.create as jest.Mock).mockResolvedValue({});

    const resp = await request(app)
      .post('/api/whatsapp/webhook')
      .type('form')
      .send({ From: `whatsapp:${samplePhone}`, Body: 'withdraw all' });

    expect(resp.status).toBe(200);
    expect(resp.text).toMatch(/withdraw all/);
    expect(db.transaction.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ type: 'WITHDRAWAL', amount: 123 }),
    }));
  });
});
