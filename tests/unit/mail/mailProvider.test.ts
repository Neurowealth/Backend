import { MockMailProvider } from '../../../src/mail/mailProvider'
import {
  renderEmailVerification,
  renderAlertEmail,
} from '../../../src/mail/templates'

describe('mailProvider (#367)', () => {
  it('sends email using MockMailProvider when plaintext is provided', async () => {
    const provider = new MockMailProvider()

    const result = await provider.send({
      to: 'user@example.com',
      subject: 'Test Subject',
      html: '<h1>Hello</h1>',
      text: 'Hello',
    })

    expect(result.provider).toBe('mock')
    expect(result.messageId).toMatch(/^msg_mock_/)
    expect(provider.sentMessages.length).toBe(1)
    expect(provider.sentMessages[0].to).toBe('user@example.com')
  })

  it('rejects email messages without plaintext content', async () => {
    const provider = new MockMailProvider()

    await expect(
      provider.send({
        to: 'user@example.com',
        subject: 'No Text',
        html: '<h1>Hello</h1>',
        text: '',
      })
    ).rejects.toThrow(/must include a plaintext part/)
  })

  it('renders templates with required HTML and plaintext parts', () => {
    const verifyMsg = renderEmailVerification(
      'user@example.com',
      'https://neurowealth.app/verify?token=123'
    )
    expect(verifyMsg.to).toBe('user@example.com')
    expect(verifyMsg.html).toContain('https://neurowealth.app/verify?token=123')
    expect(verifyMsg.text).toContain('https://neurowealth.app/verify?token=123')

    const alertMsg = renderAlertEmail('user@example.com', {
      metric: 'PROTOCOL_APY',
      comparator: 'LT',
      threshold: 5,
      observedValue: 3.2,
      protocolName: 'Blend',
    })
    expect(alertMsg.subject).toContain('[ALERT]')
    expect(alertMsg.html).toContain('Blend')
    expect(alertMsg.text).toContain('Blend')
  })
})
