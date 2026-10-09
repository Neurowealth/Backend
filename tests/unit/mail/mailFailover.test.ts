/**
 * #496 — Mail delivery failover: the notification leg that most user-facing
 * flows depend on (email verification, alerts, receipts).
 *
 * The MailRegistry owns the delivery guarantee: primary provider first,
 * automatic failover to the fallback when the primary throws, and recovery
 * back to the primary after the 60s health window. #496's acceptance
 * criteria map to:
 *
 *   success path   → primary sends, fallback untouched
 *   failure path   → fallback delivers when the primary throws
 *   retry events   → registry returns healthy after the recovery window
 *   incident context → failures are logged, never thrown to the caller's
 *                      business flow
 */

import type {
  MailMessage,
  MailProvider,
  MailSendResult,
} from '../../../src/mail/mailProvider'
import {
  MailRegistry,
  SesSignatureVerificationError,
} from '../../../src/mail/mailProvider'

jest.mock('../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

function makeProvider(name: string): MailProvider & { sent: MailMessage[] } {
  return {
    name,
    sent: [],
    async send(message: MailMessage): Promise<MailSendResult> {
      this.sent.push(message)
      return { messageId: `${name}-id`, provider: name }
    },
    parseWebhook: jest.fn().mockReturnValue(null),
  }
}

function message(to = 'user@example.com'): MailMessage {
  return { to, subject: 'Hello', html: '<p>Hello</p>', text: 'Hello' }
}

describe('MailRegistry failover (#496)', () => {
  it('sends via the primary while it is healthy and never touches the fallback', async () => {
    const primary = makeProvider('primary')
    const fallback = makeProvider('fallback')
    const registry = new MailRegistry(primary, fallback)

    const result = await registry.send(message())

    expect(result.provider).toBe('primary')
    expect(primary.sent).toHaveLength(1)
    expect(fallback.sent).toHaveLength(0)
  })

  it('fails over to the fallback when the primary provider throws', async () => {
    // Freeze the 60s recovery timer so nothing leaks past the test.
    jest.useFakeTimers()
    try {
      const primary = makeProvider('primary')
      primary.send = jest.fn().mockRejectedValue(new Error('SES throttling'))
      const fallback = makeProvider('fallback')
      const registry = new MailRegistry(primary, fallback)

      const result = await registry.send(message('user1@example.com'))

      // The user still gets their mail — via the fallback provider.
      expect(result.provider).toBe('fallback')
      expect(fallback.sent).toHaveLength(1)
      expect(fallback.sent[0].to).toBe('user1@example.com')
      expect(primary.send).toHaveBeenCalledTimes(1)
    } finally {
      jest.useRealTimers()
    }
  })

  it('keeps routing to the fallback until the recovery window elapses', async () => {
    jest.useFakeTimers()
    try {
      const primary = makeProvider('primary')
      let fail = true
      primary.send = jest.fn(async () => {
        if (fail) throw new Error('primary down')
        return { messageId: 'p', provider: 'primary' }
      })
      const fallback = makeProvider('fallback')
      const registry = new MailRegistry(primary, fallback)

      await registry.send(message()) // flips the registry unhealthy
      await registry.send(message('second@example.com'))

      // Still inside the window: the fallback serves every delivery...
      expect(fallback.sent).toHaveLength(2)
      expect(primary.send).toHaveBeenCalledTimes(1)

      // ...until the 60s recovery timer restores the primary.
      fail = false
      jest.advanceTimersByTime(61_000)
      const recovered = await registry.send(message('third@example.com'))

      expect(recovered.provider).toBe('primary')
      // The primary saw the original failure and the post-recovery send.
      expect(primary.send).toHaveBeenCalledTimes(2)
    } finally {
      jest.useRealTimers()
    }
  })

  it('prefers the primary provider when parsing mail webhooks', async () => {
    const primary = makeProvider('primary')
    ;(primary.parseWebhook as jest.Mock).mockReturnValue({
      type: 'bounce',
      messageId: 'm-1',
      recipient: 'user@example.com',
    })
    const fallback = makeProvider('fallback')
    const registry = new MailRegistry(primary, fallback)

    await expect(
      registry.parseWebhook({ notificationType: 'Bounce' })
    ).resolves.toMatchObject({
      type: 'bounce',
    })

    // When the primary yields nothing, the fallback gets a chance.
    ;(primary.parseWebhook as jest.Mock).mockReturnValue(null)
    ;(fallback.parseWebhook as jest.Mock).mockReturnValue({
      type: 'delivery',
      messageId: 'm-2',
      recipient: 'user@example.com',
    })
    await expect(
      registry.parseWebhook({ notificationType: 'Delivery' })
    ).resolves.toMatchObject({
      type: 'delivery',
    })
  })

  it('propagates a primary authentication rejection instead of falling back', async () => {
    const primary = makeProvider('primary')
    const reject = new SesSignatureVerificationError('invalid_signature')
    ;(primary.parseWebhook as jest.Mock).mockRejectedValue(reject)
    const fallback = makeProvider('fallback')
    fallback.parseWebhook = jest
      .fn()
      .mockResolvedValue({
        type: 'delivery',
        messageId: 'm-2',
        recipient: 'u@e.co',
      })
    const registry = new MailRegistry(primary, fallback)

    // A forged/tampered SES payload must never be rescued into processing by a
    // fallback that trusts its shape (#524).
    await expect(
      registry.parseWebhook({ notificationType: 'Bounce' })
    ).rejects.toMatchObject({ code: 'SES_WEBHOOK_SIGNATURE_INVALID' })
    expect(fallback.parseWebhook).not.toHaveBeenCalled()
  })
})
