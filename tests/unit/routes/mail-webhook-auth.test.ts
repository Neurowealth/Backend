/**
 * POST /api/webhooks/mail is a provider callback. It must accept a signed
 * body with no application JWT or API key, while every other route on the
 * same router stays behind requireAuth (#851).
 */
import crypto from 'crypto'
import express from 'express'
import request from 'supertest'
import webhooksRouter from '../../../src/routes/webhooks'
import { mailRegistry } from '../../../src/mail/mailProvider'

const SECRET = 'mail-webhook-test-secret'

const app = express()
app.use(express.json())
app.use('/api/webhooks', webhooksRouter)

function sign(payload: object): string {
  return crypto
    .createHmac('sha256', SECRET)
    .update(JSON.stringify(payload))
    .digest('hex')
}

describe('mail webhook authentication (#851)', () => {
  const previous = {
    host: process.env.SMTP_HOST,
    user: process.env.SMTP_USER,
    secret: process.env.SMTP_WEBHOOK_SECRET,
  }

  beforeAll(() => {
    process.env.SMTP_HOST = 'smtp.example.com'
    process.env.SMTP_USER = 'mailer'
    process.env.SMTP_WEBHOOK_SECRET = SECRET
    mailRegistry.refreshProviders()
  })

  afterAll(() => {
    restore('SMTP_HOST', previous.host)
    restore('SMTP_USER', previous.user)
    restore('SMTP_WEBHOOK_SECRET', previous.secret)
    mailRegistry.refreshProviders()
  })

  it('accepts a signed provider callback without an application credential', async () => {
    const payload = {
      event: 'delivery',
      messageId: 'msg-1',
      email: 'user@example.com',
    }

    const res = await request(app)
      .post('/api/webhooks/mail')
      .set('x-signature', sign(payload))
      .send(payload)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      success: true,
      message: 'Mail webhook processed',
    })
  })

  it('rejects an unsigned provider callback', async () => {
    const res = await request(app).post('/api/webhooks/mail').send({
      event: 'delivery',
      messageId: 'msg-2',
      email: 'user@example.com',
    })

    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'Unauthorized' })
  })

  it.each([
    ['get', '/api/webhooks'],
    ['post', '/api/webhooks'],
    ['get', '/api/webhooks/endpoints'],
    ['post', '/api/webhooks/endpoints'],
  ] as const)('%s %s still requires authentication', async (method, path) => {
    const res = await request(app)[method](path).send({})
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Unauthorized')
  })
})

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}
