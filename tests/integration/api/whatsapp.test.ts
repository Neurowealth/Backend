import request from 'supertest'
import app from '../../../src/index'
import { db } from '../../../src/db'
import { UserManager } from '../../../src/whatsapp/userManager'

describe('WhatsApp Webhook Integration Tests', () => {
  const testPhoneNumber = '+1234567890'
  let testUser: any

  beforeAll(async () => {
    // Clean up any existing test data
    await db.user.deleteMany({
      where: { phoneNumber: testPhoneNumber.replace('+', '') }
    })
  })

  afterAll(async () => {
    // Clean up test data
    if (testUser) {
      await db.user.deleteMany({
        where: { phoneNumber: testPhoneNumber.replace('+', '') }
      })
    }
  })

  describe('POST /api/whatsapp/webhook', () => {
    it('should handle new user onboarding with OTP', async () => {
      const response = await request(app)
        .post('/api/whatsapp/webhook')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send({
          From: `whatsapp:${testPhoneNumber}`,
          Body: 'balance'
        })

      expect(response.status).toBe(200)
      expect(response.type).toBe('text/xml')
      expect(response.text).toContain('Welcome to NeuroWealth')
      expect(response.text).toContain('Demo OTP')
    })

    it('should handle OTP verification', async () => {
      // First get the user and generate OTP
      testUser = await UserManager.findOrCreateUser(testPhoneNumber)
      const otp = await UserManager.generateOTP(testUser.id)

      const response = await request(app)
        .post('/api/whatsapp/webhook')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send({
          From: `whatsapp:${testPhoneNumber}`,
          Body: otp
        })

      expect(response.status).toBe(200)
      expect(response.type).toBe('text/xml')
      expect(response.text).toContain('Account Verified')
    })

    it('should handle balance inquiry for verified user', async () => {
      const response = await request(app)
        .post('/api/whatsapp/webhook')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send({
          From: `whatsapp:${testPhoneNumber}`,
          Body: 'balance'
        })

      expect(response.status).toBe(200)
      expect(response.type).toBe('text/xml')
      expect(response.text).toContain('Your Portfolio')
    })

    it('should handle deposit request', async () => {
      const response = await request(app)
        .post('/api/whatsapp/webhook')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send({
          From: `whatsapp:${testPhoneNumber}`,
          Body: 'deposit 100 USDC'
        })

      expect(response.status).toBe(200)
      expect(response.type).toBe('text/xml')
      expect(response.text).toContain('Deposit Instructions')
      expect(response.text).toContain('100 USDC')
    })

    it('should handle withdrawal request', async () => {
      const response = await request(app)
        .post('/api/whatsapp/webhook')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send({
          From: `whatsapp:${testPhoneNumber}`,
          Body: 'withdraw 50 USDC'
        })

      expect(response.status).toBe(200)
      expect(response.type).toBe('text/xml')
      expect(response.text).toContain('Withdrawal Request')
    })

    it('should handle help command', async () => {
      const response = await request(app)
        .post('/api/whatsapp/webhook')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send({
          From: `whatsapp:${testPhoneNumber}`,
          Body: 'help'
        })

      expect(response.status).toBe(200)
      expect(response.type).toBe('text/xml')
      expect(response.text).toContain('NeuroWealth AI Agent')
      expect(response.text).toContain('Available Commands')
    })

    it('should handle unknown commands', async () => {
      const response = await request(app)
        .post('/api/whatsapp/webhook')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send({
          From: `whatsapp:${testPhoneNumber}`,
          Body: 'unknown command'
        })

      expect(response.status).toBe(200)
      expect(response.type).toBe('text/xml')
      expect(response.text).toContain('NeuroWealth AI Agent')
    })

    it('should reject invalid OTP', async () => {
      // Create a new unverified user for this test
      const newPhone = '+0987654321'
      await UserManager.findOrCreateUser(newPhone)

      const response = await request(app)
        .post('/api/whatsapp/webhook')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send({
          From: `whatsapp:${newPhone}`,
          Body: '123456' // Invalid OTP
        })

      expect(response.status).toBe(200)
      expect(response.type).toBe('text/xml')
      expect(response.text).toContain('Invalid OTP')

      // Clean up
      await db.user.deleteMany({
        where: { phoneNumber: newPhone.replace('+', '') }
      })
    })
  })

  describe('GET /api/whatsapp/webhook', () => {
    it('should return health check', async () => {
      const response = await request(app)
        .get('/api/whatsapp/webhook')

      expect(response.status).toBe(200)
      expect(response.text).toBe('WhatsApp webhook is active')
    })
  })
})