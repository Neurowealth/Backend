/**
 * #524 — SES mail webhooks arrive as AWS SNS envelopes whose `Signature` must
 * be cryptographically verified before the payload is trusted. Previously the
 * SES provider concatenated Message + Timestamp + Type and returned `true`
 * unconditionally, so any plausible body could flip an EmailIdentity to
 * BOUNCED/COMPLAINED.
 *
 * These tests exercise the canonical-string builder and the verifier with real
 * RSA keypairs generated in-process — no network, no AWS. The same public key
 * is served as the "signing certificate" via an injected `fetchCert`, which is
 * exactly how `createPublicKey` consumes the SPKI PEM AWS publishes.
 */

import crypto from 'node:crypto'
import {
  buildSignableString,
  createSnsSignatureVerifier,
  isAllowedSigningCertHost,
  type SnsMessage,
  type SnsSignatureVerifier,
} from '../../../src/mail/snsSignature'
import {
  SesMailProvider,
  SesSignatureVerificationError,
} from '../../../src/mail/mailProvider'

jest.mock('../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock('../../../src/utils/metrics', () => ({
  mailWebhookRejectionsTotal: { inc: jest.fn() },
}))

const PUBLIC_KEY = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
// SPKI PEM is what AWS publishes at SigningCertUrl and what createPublicKey
// accepts as the certificate's public key.
const PUBLIC_PEM = PUBLIC_KEY.publicKey
  .export({ type: 'spki', format: 'pem' })
  .toString()

type PartialEnvelope = Partial<SnsMessage>

function makeEnvelope(partial: PartialEnvelope = {}): SnsMessage {
  return {
    Type: 'Notification',
    MessageId: 'message-id-1',
    TopicArn: 'arn:aws:sns:us-east-1:123456789012:ses-webhook',
    Message: 'hello-from-sns',
    Timestamp: '2025-01-01T00:00:00.000Z',
    SignatureVersion: '2',
    SigningCertUrl:
      'https://sns.us-east-1.amazonaws.com/simple-notification-certificate.pem',
    ...partial,
  }
}

/** Sign a copy of the envelope with the test key, filling in Signature/SignatureVersion. */
function signEnvelope(
  message: SnsMessage,
  version: '1' | '2' = '2'
): SnsMessage {
  const withVersion: SnsMessage = { ...message, SignatureVersion: version }
  const signed = buildSignableString(withVersion)
  const signature = crypto
    .createSign(version === '1' ? 'sha1' : 'sha256')
    .update(signed)
    .sign(PUBLIC_KEY.privateKey)
    .toString('base64')
  return { ...withVersion, Signature: signature }
}

/** SES bounce/complaint notification JSON as SNS would carry it in `Message`. */
function sesNotificationJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    notificationType: 'Bounce',
    mail: {
      messageId: '0100010001',
      destination: ['user@example.com'],
    },
    bounce: {
      bounceType: 'Permanent',
      bounceSubType: 'General',
      bouncedRecipients: [],
    },
    ...overrides,
  })
}

function makeVerifier(
  options: {
    fetchCert?: (url: string) => Promise<string>
    now?: () => number
    cacheTtlMs?: number
  } = {}
): { verifier: SnsSignatureVerifier; fetchCert: jest.Mock } {
  const fetchCert = (options.fetchCert ??
    jest.fn().mockResolvedValue(PUBLIC_PEM)) as jest.Mock
  const verifier = createSnsSignatureVerifier({
    fetchCert,
    now: options.now,
    cacheTtlMs: options.cacheTtlMs,
  })
  return { verifier, fetchCert }
}

describe('buildSignableString (#524)', () => {
  it('builds the canonical Notification string in field order', () => {
    const message = makeEnvelope()
    expect(buildSignableString(message)).toBe(
      [
        'Message\nhello-from-sns',
        'MessageId\nmessage-id-1',
        'Timestamp\n2025-01-01T00:00:00.000Z',
        'TopicArn\narn:aws:sns:us-east-1:123456789012:ses-webhook',
        'Type\nNotification',
      ].join('\n') + '\n'
    )
  })

  it('prepends Subject only when present', () => {
    const withSubject = buildSignableString(
      makeEnvelope({ Subject: 'You have alert' })
    )
    expect(withSubject.startsWith('Subject\nYou have alert\n')).toBe(true)
    // Notification ordering: Subject first, then Message and the rest.
    expect(withSubject).toMatch(/^Subject\n[^\n]+\nMessage\nhello-from-sns\n/)
  })

  it('omits absent fields rather than emitting empty values', () => {
    const message = makeEnvelope()
    delete message.Subject
    const withMissing = buildSignableString(message)
    expect(withMissing).not.toContain('Subject')
    expect(withMissing).not.toContain('\n\n')
  })

  it('uses the confirmation field set for SubscriptionConfirmation', () => {
    const confirmation: SnsMessage = {
      Type: 'SubscriptionConfirmation',
      MessageId: 'sub-id',
      TopicArn: 'arn:aws:sns:us-east-1:123456789012:ses-webhook',
      Message: 'confirm',
      Timestamp: '2025-01-01T00:00:00.000Z',
      Token: 'token-abc',
      SubscribeURL: 'https://sns.us-east-1.amazonaws.com/confirm?token=abc',
      SignatureVersion: '2',
    }
    expect(buildSignableString(confirmation)).toBe(
      [
        'Message\nconfirm',
        'MessageId\nsub-id',
        'SubscribeURL\nhttps://sns.us-east-1.amazonaws.com/confirm?token=abc',
        'Timestamp\n2025-01-01T00:00:00.000Z',
        'Token\ntoken-abc',
        'TopicArn\narn:aws:sns:us-east-1:123456789012:ses-webhook',
        'Type\nSubscriptionConfirmation',
      ].join('\n') + '\n'
    )
  })

  it('treats UnsubscribeConfirmation like SubscriptionConfirmation', () => {
    const confirmation: SnsMessage = {
      Type: 'UnsubscribeConfirmation',
      Message: 'bye',
      MessageId: 'id',
      SubscribeURL: 'https://sns.us-east-1.amazonaws.com/unsub',
      Timestamp: '2025-01-01T00:00:00.000Z',
      Token: 'tok',
      TopicArn: 'arn:aws:sns:us-east-1:123456789012:ses-webhook',
      SignatureVersion: '2',
    }
    const string = buildSignableString(confirmation)
    expect(string).toContain(
      'SubscribeURL\nhttps://sns.us-east-1.amazonaws.com/unsub\n'
    )
    expect(string).toContain('Token\ntok\n')
  })
})

describe('isAllowedSigningCertHost (#524)', () => {
  it.each([
    ['sns.us-east-1.amazonaws.com', true],
    ['sns.us-east-2.amazonaws.com', true],
    ['sns.eu-west-1.amazonaws.com', true],
    ['sns.us-gov-west-1.amazonaws.com', true],
    ['example.com', false],
    ['sns.amazonaws.com.evil.com', false],
    ['sub.sns.us-east-1.amazonaws.com', false],
    ['sns.us-east-1.amazonaws.com.', false],
    ['somethingsns.us-east-1.amazonaws.com', false],
  ])('%s → %s', (host, expected) => {
    expect(isAllowedSigningCertHost(host)).toBe(expected)
  })
})

describe('createSnsSignatureVerifier (#524)', () => {
  it('accepts a genuine Notification signed with SHA-256 (SignatureVersion 2)', async () => {
    const { verifier, fetchCert } = makeVerifier()
    await expect(
      verifier.verify(signEnvelope(makeEnvelope()))
    ).resolves.toEqual({
      ok: true,
    })
    expect(fetchCert).toHaveBeenCalledWith(makeEnvelope().SigningCertUrl)
  })

  it('accepts a signature built with SHA-1 (SignatureVersion 1)', async () => {
    const { verifier } = makeVerifier()
    const message = signEnvelope(makeEnvelope(), '1')
    await expect(verifier.verify(message)).resolves.toEqual({ ok: true })
  })

  it('defaults to SignatureVersion 1 like AWS SNS', async () => {
    const { verifier } = makeVerifier()
    const sha1Signed = signEnvelope(makeEnvelope(), '1')
    delete sha1Signed.SignatureVersion
    await expect(verifier.verify(sha1Signed)).resolves.toEqual({ ok: true })
  })

  it('rejects a tampered Message as invalid_signature', async () => {
    const { verifier } = makeVerifier()
    const message = signEnvelope(makeEnvelope())
    message.Message = 'this-was-altered'
    await expect(verifier.verify(message)).resolves.toEqual({
      ok: false,
      reason: 'invalid_signature',
    })
  })

  it('rejects a MessageId swapped after signing', async () => {
    const { verifier } = makeVerifier()
    const message = signEnvelope(makeEnvelope())
    message.MessageId = 'swapped-id'
    await expect(verifier.verify(message)).resolves.toEqual({
      ok: false,
      reason: 'invalid_signature',
    })
  })

  it('rejects a spoofed certificate host without fetching it', async () => {
    const { verifier, fetchCert } = makeVerifier()
    const message = signEnvelope(
      makeEnvelope({
        SigningCertUrl:
          'https://attacker.example.com/simple-notification-certificate.pem',
      })
    )
    await expect(verifier.verify(message)).resolves.toEqual({
      ok: false,
      reason: 'bad_cert_url',
    })
    expect(fetchCert).not.toHaveBeenCalled()
  })

  it.each([
    ['http instead of https', 'http://sns.us-east-1.amazonaws.com/cert.pem'],
    ['not a URL', 'not-a-url'],
    ['empty string', ''],
  ])(
    'rejects a certificate URL with %s before fetching',
    async (_label, url) => {
      const { verifier, fetchCert } = makeVerifier()
      const message = signEnvelope(makeEnvelope({ SigningCertUrl: url }))
      await expect(verifier.verify(message)).resolves.toEqual({
        ok: false,
        reason: 'bad_cert_url',
      })
      expect(fetchCert).not.toHaveBeenCalled()
    }
  )

  it('fails closed when the certificate cannot be fetched', async () => {
    const { verifier } = makeVerifier({
      fetchCert: jest.fn().mockRejectedValue(new Error('network down')),
    })
    await expect(
      verifier.verify(signEnvelope(makeEnvelope()))
    ).resolves.toEqual({
      ok: false,
      reason: 'cert_fetch_failed',
    })
  })

  it('does not cache a failed fetch, so the next attempt retries', async () => {
    const fetchCert = jest
      .fn()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce(PUBLIC_PEM)
    const { verifier } = makeVerifier({ fetchCert })
    const message = signEnvelope(makeEnvelope())

    await expect(verifier.verify(message)).resolves.toEqual({
      ok: false,
      reason: 'cert_fetch_failed',
    })
    await expect(verifier.verify(message)).resolves.toEqual({ ok: true })
    expect(fetchCert).toHaveBeenCalledTimes(2)
  })

  it('accepts a genuine SubscriptionConfirmation', async () => {
    const { verifier } = makeVerifier()
    const confirmation = signEnvelope({
      Type: 'SubscriptionConfirmation',
      MessageId: 'sub-id',
      TopicArn: 'arn:aws:sns:us-east-1:123456789012:ses-webhook',
      Message: 'confirm-subscription',
      Timestamp: '2025-01-01T00:00:00.000Z',
      Token: 'token-abc',
      SubscribeURL: 'https://sns.us-east-1.amazonaws.com/confirm/sub?token=abc',
      SigningCertUrl:
        'https://sns.us-east-1.amazonaws.com/simple-notification-certificate.pem',
    })
    await expect(verifier.verify(confirmation)).resolves.toEqual({ ok: true })
  })

  it('rejects a confirmation tampered by removing Token', async () => {
    const { verifier } = makeVerifier()
    const confirmation = signEnvelope({
      Type: 'SubscriptionConfirmation',
      MessageId: 'sub-id',
      TopicArn: 'arn:aws:sns:us-east-1:123456789012:ses-webhook',
      Message: 'confirm-subscription',
      Timestamp: '2025-01-01T00:00:00.000Z',
      Token: 'token-abc',
      SubscribeURL: 'https://sns.us-east-1.amazonaws.com/confirm/sub?token=abc',
      SigningCertUrl:
        'https://sns.us-east-1.amazonaws.com/simple-notification-certificate.pem',
    })
    delete (confirmation as Partial<SnsMessage>).Token
    await expect(verifier.verify(confirmation)).resolves.toEqual({
      ok: false,
      reason: 'invalid_signature',
    })
  })

  it('rejects an unsupported SignatureVersion', async () => {
    const { verifier } = makeVerifier()
    const message = signEnvelope(makeEnvelope())
    message.SignatureVersion = '3'
    await expect(verifier.verify(message)).resolves.toEqual({
      ok: false,
      reason: 'unsupported_signature_version',
    })
  })

  it('rejects an unknown message Type', async () => {
    const { verifier } = makeVerifier()
    const unknownType = {
      ...makeEnvelope(),
      Type: 'Unknown',
    } as unknown as SnsMessage
    const message = signEnvelope(unknownType)
    message.Signature = 'dGVzdA=='
    await expect(verifier.verify(message)).resolves.toEqual({
      ok: false,
      reason: 'unsupported_message_type',
    })
  })

  it('rejects a message missing its Signature', async () => {
    const { verifier } = makeVerifier()
    const message = makeEnvelope()
    delete message.Signature
    await expect(verifier.verify(message)).resolves.toEqual({
      ok: false,
      reason: 'missing_signing_fields',
    })
  })

  it('caches the certificate per URL within the TTL and refetches after expiry', async () => {
    let now = 0
    const fetchCert = jest.fn().mockResolvedValue(PUBLIC_PEM)
    const verifier = createSnsSignatureVerifier({
      fetchCert,
      now: () => now,
      cacheTtlMs: 1000,
    })
    const first = signEnvelope(makeEnvelope({ Message: 'one' }))
    const second = signEnvelope(makeEnvelope({ Message: 'two' }))

    await verifier.verify(first)
    await verifier.verify(second)
    expect(fetchCert).toHaveBeenCalledTimes(1)

    now = 1500
    await verifier.verify(signEnvelope(makeEnvelope({ Message: 'three' })))
    expect(fetchCert).toHaveBeenCalledTimes(2)
  })
})

describe('SesMailProvider.parseWebhook (#524)', () => {
  it('maps a signed SES bounce notification to a bounce event', async () => {
    const envelope = signEnvelope(
      makeEnvelope({ Message: sesNotificationJson() })
    )
    const provider = new SesMailProvider({
      snsVerifier: makeVerifier().verifier,
    })

    await expect(provider.parseWebhook(envelope)).resolves.toEqual({
      type: 'bounce',
      messageId: '0100010001',
      recipient: 'user@example.com',
      reason: 'Permanent',
    })
  })

  it('maps a signed SES complaint notification to a complaint event', async () => {
    const envelope = signEnvelope(
      makeEnvelope({
        Message: sesNotificationJson({
          notificationType: 'Complaint',
          complaint: { complaintFeedbackType: 'abuse' },
          bounce: undefined,
        }),
      })
    )
    const provider = new SesMailProvider({
      snsVerifier: makeVerifier().verifier,
    })

    await expect(provider.parseWebhook(envelope)).resolves.toMatchObject({
      type: 'complaint',
      reason: 'abuse',
    })
  })

  it('throws SesSignatureVerificationError on a tampered envelope', async () => {
    const envelope = signEnvelope(
      makeEnvelope({ Message: sesNotificationJson() })
    )
    envelope.Message = sesNotificationJson({
      mail: { messageId: 'forged', destination: ['attacker@example.com'] },
    })
    const provider = new SesMailProvider({
      snsVerifier: makeVerifier().verifier,
    })

    await expect(provider.parseWebhook(envelope)).rejects.toBeInstanceOf(
      SesSignatureVerificationError
    )
    await expect(provider.parseWebhook(envelope)).rejects.toMatchObject({
      code: 'SES_WEBHOOK_SIGNATURE_INVALID',
      reason: 'invalid_signature',
    })
  })

  it('throws SesSignatureVerificationError on a spoofed certificate host', async () => {
    const envelope = signEnvelope(
      makeEnvelope({
        Message: sesNotificationJson(),
        SigningCertUrl: 'https://evil.example.com/cert.pem',
      })
    )
    const { verifier, fetchCert } = makeVerifier()
    const provider = new SesMailProvider({ snsVerifier: verifier })

    await expect(provider.parseWebhook(envelope)).rejects.toMatchObject({
      code: 'SES_WEBHOOK_SIGNATURE_INVALID',
      reason: 'bad_cert_url',
    })
    // The attacker host is never contacted.
    expect(fetchCert).not.toHaveBeenCalled()
  })

  it('rejects a plausible SES-looking body that is not an SNS envelope', async () => {
    const provider = new SesMailProvider({
      snsVerifier: makeVerifier().verifier,
    })
    const directSesBody = {
      notificationType: 'Bounce',
      mail: { messageId: '0100010001', destination: ['user@example.com'] },
      bounce: { bounceType: 'Permanent' },
    }

    await expect(provider.parseWebhook(directSesBody)).rejects.toMatchObject({
      code: 'SES_WEBHOOK_SIGNATURE_INVALID',
      reason: 'missing_signing_fields',
    })
  })

  it('returns null for an unparseable SNS Message payload', async () => {
    const envelope = signEnvelope(makeEnvelope({ Message: 'not-json-' }))
    const provider = new SesMailProvider({
      snsVerifier: makeVerifier().verifier,
    })

    await expect(provider.parseWebhook(envelope)).resolves.toBeNull()
  })

  it('returns null for a non-object payload', async () => {
    const provider = new SesMailProvider({
      snsVerifier: makeVerifier().verifier,
    })
    await expect(provider.parseWebhook(null)).resolves.toBeNull()
  })
})
