process.env.NODE_ENV = 'test'
process.env.TELEGRAM_BOT_TOKEN = 'test-token'
process.env.TWILIO_ACCOUNT_SID = 'AC' + '0'.repeat(32)
process.env.TWILIO_AUTH_TOKEN = '0'.repeat(32)

import express from 'express'
import request from 'supertest'
import adminRouter from '../../../src/routes/admin'
import { messageDeliveryService } from '../../../src/messaging/service'

jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: {
    adminAuditLog: {
      create: jest.fn().mockResolvedValue({ id: 'audit-log-1' }),
    },
  },
}))

jest.mock('../../../src/middleware/adminAuth', () => {
  const actual = jest.requireActual('../../../src/middleware/adminAuth')
  return {
    ...actual,
    requireAdminAuth: (req: any, res: any, next: any) => {
      res.locals.adminAuth = {
        id: 'admin-1',
        name: 'Super Admin',
        role: 'super',
        scopes: ['super', 'messages:read', 'messages:write'],
      }
      next()
    },
    requireAdminScope: (_scope: string) => (_req: any, _res: any, next: any) => next(),
  }
})

describe('Admin Messages Recovery Routes (#493)', () => {
  let app: express.Application

  beforeEach(() => {
    messageDeliveryService.clearStoreForTests()
    jest.restoreAllMocks()

    app = express()
    app.use(express.json())
    app.use('/api/admin', adminRouter)
  })

  it('GET /api/admin/messages lists tracked messages', async () => {
    const listSpy = jest.spyOn(messageDeliveryService, 'listMessages').mockResolvedValue({
      messages: [
        {
          id: 'msg-1',
          channel: 'TELEGRAM',
          recipient: '123456',
          userId: 'user-1',
          category: 'ALERT',
          body: 'Price alert triggered',
          status: 'DELIVERED',
          priority: 'NORMAL',
          attempts: 1,
          maxAttempts: 5,
          nextAttemptAt: null,
          lastError: null,
          providerMessageId: 'p-1',
          metadata: null,
          fallbackChannel: null,
          fallbackRecipient: null,
          fallbackTriggered: false,
          deliveredAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      total: 1,
    })

    const res = await request(app).get('/api/admin/messages')
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data.messages.length).toBe(1)
    expect(res.body.data.messages[0].channel).toBe('TELEGRAM')
    expect(listSpy).toHaveBeenCalled()
  })

  it('GET /api/admin/messages/stats returns queue and delivery metrics', async () => {
    jest.spyOn(messageDeliveryService, 'getMessageStats').mockResolvedValue({
      total: 10,
      byStatus: { pending: 2, sending: 1, delivered: 6, failed: 0, deadLetter: 1 },
      byChannel: {
        telegram: { total: 5, delivered: 4, failed: 0, pending: 1, deadLetter: 0 },
        whatsapp: { total: 5, delivered: 2, failed: 0, pending: 2, deadLetter: 1 },
      },
    })

    const res = await request(app).get('/api/admin/messages/stats')
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data.total).toBe(10)
    expect(res.body.data.byStatus.deadLetter).toBe(1)
  })

  it('GET /api/admin/messages/:id returns message detail or 404', async () => {
    jest.spyOn(messageDeliveryService, 'getMessage').mockResolvedValueOnce({
      id: 'msg-target',
      channel: 'WHATSAPP',
      recipient: '+15551234567',
      userId: null,
      category: 'NOTIFICATION',
      body: 'Test body',
      status: 'PENDING',
      priority: 'NORMAL',
      attempts: 0,
      maxAttempts: 5,
      nextAttemptAt: null,
      lastError: null,
      providerMessageId: null,
      metadata: null,
      fallbackChannel: null,
      fallbackRecipient: null,
      fallbackTriggered: false,
      deliveredAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const foundRes = await request(app).get('/api/admin/messages/msg-target')
    expect(foundRes.status).toBe(200)
    expect(foundRes.body.data.id).toBe('msg-target')

    jest.spyOn(messageDeliveryService, 'getMessage').mockResolvedValueOnce(null)
    const notFoundRes = await request(app).get('/api/admin/messages/non-existent')
    expect(notFoundRes.status).toBe(404)
    expect(notFoundRes.body.success).toBe(false)
  })

  it('POST /api/admin/messages/:id/retry triggers manual recovery', async () => {
    jest.spyOn(messageDeliveryService, 'getMessage').mockResolvedValueOnce({
      id: 'msg-to-retry',
      channel: 'TELEGRAM',
      recipient: '123',
      userId: null,
      category: 'NOTIFICATION',
      body: 'text',
      status: 'DEAD_LETTER',
      priority: 'NORMAL',
      attempts: 5,
      maxAttempts: 5,
      nextAttemptAt: null,
      lastError: 'Fatal error',
      providerMessageId: null,
      metadata: null,
      fallbackChannel: null,
      fallbackRecipient: null,
      fallbackTriggered: false,
      deliveredAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    jest.spyOn(messageDeliveryService, 'retryMessage').mockResolvedValueOnce({
      id: 'msg-to-retry',
      channel: 'TELEGRAM',
      recipient: '123',
      userId: null,
      category: 'NOTIFICATION',
      body: 'text',
      status: 'DELIVERED',
      priority: 'NORMAL',
      attempts: 1,
      maxAttempts: 5,
      nextAttemptAt: null,
      lastError: null,
      providerMessageId: 'recovered-id',
      metadata: null,
      fallbackChannel: null,
      fallbackRecipient: null,
      fallbackTriggered: false,
      deliveredAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const res = await request(app).post('/api/admin/messages/msg-to-retry/retry')
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data.status).toBe('DELIVERED')
  })

  it('POST /api/admin/messages/retry-dead-letters bulk retries dead letters', async () => {
    jest
      .spyOn(messageDeliveryService, 'retryAllDeadLetters')
      .mockResolvedValueOnce({ count: 4 })

    const res = await request(app)
      .post('/api/admin/messages/retry-dead-letters')
      .send({ channel: 'WHATSAPP' })

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data.count).toBe(4)
  })

  it('DELETE /api/admin/messages/:id cancels a delivery', async () => {
    jest.spyOn(messageDeliveryService, 'getMessage').mockResolvedValueOnce({
      id: 'msg-to-cancel',
      channel: 'TELEGRAM',
      recipient: '123',
      userId: null,
      category: 'NOTIFICATION',
      body: 'text',
      status: 'PENDING',
      priority: 'NORMAL',
      attempts: 0,
      maxAttempts: 5,
      nextAttemptAt: null,
      lastError: null,
      providerMessageId: null,
      metadata: null,
      fallbackChannel: null,
      fallbackRecipient: null,
      fallbackTriggered: false,
      deliveredAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    jest.spyOn(messageDeliveryService, 'cancelMessage').mockResolvedValueOnce({
      id: 'msg-to-cancel',
      channel: 'TELEGRAM',
      recipient: '123',
      userId: null,
      category: 'NOTIFICATION',
      body: 'text',
      status: 'FAILED',
      priority: 'NORMAL',
      attempts: 0,
      maxAttempts: 5,
      nextAttemptAt: null,
      lastError: 'Cancelled by administrator',
      providerMessageId: null,
      metadata: null,
      fallbackChannel: null,
      fallbackRecipient: null,
      fallbackTriggered: false,
      deliveredAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const res = await request(app).delete('/api/admin/messages/msg-to-cancel')
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data.status).toBe('FAILED')
  })
})
