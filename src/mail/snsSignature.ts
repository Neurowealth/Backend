/**
 * AWS SNS signature verification for SES mail webhooks (#524).
 *
 * SES publishes bounce / complaint notifications through SNS. Every delivery
 * is an SNS envelope: a JSON body whose `Signature` covers a canonical string
 * built from the message's own fields, signed by the AWS private key whose
 * certificate SNS publishes at `SigningCertURL`. Before this module, the SES
 * provider treated that envelope as something to structure-validate and
 * unconditionally returned `true` — a webhook URL was a forge button: any
 * plausible body could flip `EmailIdentity.status` to BOUNCED/COMPLAINED and
 * silently kill a user's email channel.
 *
 * Verification is:
 *
 *   1. Reject every `SigningCertURL` whose host is not `sns.<region>.
 *      amazonaws.com` (and require https) — closes the SSRF / spoof vector
 *      before any bytes are fetched.
 *   2. Fetch that certificate once and cache it under a short TTL (AWS rotates
 *      these; expiry, not manual intervention, invalidates).
 *   3. Build the exact canonical string for the message `Type` — Notification
 *      and SubscriptionConfirmation use different field sets, a common bug is
 *      feeding one into the other.
 *   4. `crypto.verify` the base64 `Signature` against the certificate's public
 *      key with the algorithm named by `SignatureVersion`.
 *
 * Every failure is an explicit reason, not a boolean — callers choose the
 * status (401) and a metric label. Failures never cache, so a fetch blip is
 * retried on SNS's next delivery rather than poisoned by a bad cache entry.
 */

import crypto from 'node:crypto'

/** Only AWS-owned hosts are acceptable certificate origins (#524). */
export const SNS_SIGNING_CERT_HOST_RE = /^sns\.[a-z0-9-]+\.amazonaws\.com$/

export const DEFAULT_CERT_CACHE_TTL_MS = 5 * 60 * 1000
export const DEFAULT_CERT_FETCH_TIMEOUT_MS = 5_000
export const DEFAULT_SNS_MAX_AGE_MS = 15 * 60 * 1000
const SNS_CLOCK_SKEW_MS = 60_000

export type SnsMessageType =
  'Notification' | 'SubscriptionConfirmation' | 'UnsubscribeConfirmation'

export interface SnsMessage {
  Type: SnsMessageType
  SignatureVersion?: string
  Signature?: string
  SigningCertURL?: string
  Message?: unknown
  MessageId?: unknown
  Subject?: unknown
  Timestamp?: unknown
  TopicArn?: unknown
  Token?: unknown
  SubscribeURL?: unknown
  [key: string]: unknown
}

export type SnsRejectionReason =
  | 'missing_signing_fields'
  | 'bad_cert_url'
  | 'unexpected_topic'
  | 'invalid_timestamp'
  | 'unsupported_message_type'
  | 'unsupported_signature_version'
  | 'cert_fetch_failed'
  | 'invalid_signature'

export type SnsSignatureVerificationOutcome =
  { ok: true } | { ok: false; reason: SnsRejectionReason }

export interface SnsSignatureVerifier {
  verify(message: unknown): Promise<SnsSignatureVerificationOutcome>
}

export interface SnsSignatureVerifierOptions {
  fetchCert?: (url: string) => Promise<string>
  now?: () => number
  cacheTtlMs?: number
  topicArns?: readonly string[]
}

export function isSnsEnvelope(message: unknown): message is SnsMessage {
  if (!message || typeof message !== 'object') return false
  const candidate = message as Record<string, unknown>
  return (
    typeof candidate.Type === 'string' &&
    typeof candidate.Signature === 'string' &&
    candidate.Signature.length > 0
  )
}

/**
 * The canonical string SNS signs, per the exact field set prescribed for each
 * message type:
 *
 *   Notification:            Message, MessageId, Subject (only when present),
 *                            Timestamp, TopicArn, Type
 *   SubscriptionConfirmation / UnsubscribeConfirmation:
 *                            Message, MessageId, SubscribeURL, Timestamp,
 *                            Token, TopicArn, Type
 *
 * Every emitted value line is terminated with a newline; absent optional
 * fields are simply omitted. Re-use the exact strings from the payload — any
 * normalization here breaks the signature.
 */
export function buildSignableString(message: SnsMessage): string {
  const emit = (field: string): boolean => {
    const value = message[field]
    return value !== undefined && value !== null
  }
  const parts: string[] = []
  const push = (field: string): void => {
    if (!emit(field)) return
    parts.push(`${field}\n${String(message[field])}`)
  }

  if (
    message.Type === 'SubscriptionConfirmation' ||
    message.Type === 'UnsubscribeConfirmation'
  ) {
    ;[
      'Message',
      'MessageId',
      'SubscribeURL',
      'Timestamp',
      'Token',
      'TopicArn',
      'Type',
    ].forEach(push)
  } else {
    // Notification.
    ;[
      'Message',
      'MessageId',
      'Subject',
      'Timestamp',
      'TopicArn',
      'Type',
    ].forEach(push)
  }

  return parts.join('\n') + '\n'
}

async function defaultFetchCert(url: string): Promise<string> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(DEFAULT_CERT_FETCH_TIMEOUT_MS),
    redirect: 'error',
  })
  if (!response.ok) {
    throw new Error(`certificate fetch failed with HTTP ${response.status}`)
  }
  return response.text()
}

interface CacheEntry {
  pem: string
  fetchedAtMs: number
}

/**
 * Verifies SNS envelopes. Certificate downloads are cached per URL under a
 * short TTL; successful-only caching keeps failed fetches retryable. `now` and
 * `fetchCert` are injectable so tests verify real signatures without network.
 */
export function createSnsSignatureVerifier(
  options: SnsSignatureVerifierOptions = {}
): SnsSignatureVerifier {
  const fetchCert = options.fetchCert ?? defaultFetchCert
  const now = options.now ?? Date.now
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CERT_CACHE_TTL_MS
  const cache = new Map<string, CacheEntry>()

  return {
    async verify(
      rawMessage: unknown
    ): Promise<SnsSignatureVerificationOutcome> {
      const message = rawMessage as SnsMessage | undefined
      if (!message || typeof message !== 'object') {
        return { ok: false, reason: 'missing_signing_fields' }
      }
      if (
        message.Type !== 'Notification' &&
        message.Type !== 'SubscriptionConfirmation' &&
        message.Type !== 'UnsubscribeConfirmation'
      ) {
        return { ok: false, reason: 'unsupported_message_type' }
      }
      if (
        typeof message.Signature !== 'string' ||
        message.Signature.length === 0
      ) {
        return { ok: false, reason: 'missing_signing_fields' }
      }
      const signatureVersion = message.SignatureVersion ?? '1'
      const algorithm =
        signatureVersion === '1'
          ? 'sha1'
          : signatureVersion === '2'
            ? 'sha256'
            : null
      if (!algorithm) {
        return { ok: false, reason: 'unsupported_signature_version' }
      }

      // Validate the signing certificate origin before touching the network.
      const certUrl = message.SigningCertURL
      if (typeof certUrl !== 'string' || isDisallowedCertUrl(certUrl)) {
        return { ok: false, reason: 'bad_cert_url' }
      }

      const nowMs = now()
      const topicArns =
        options.topicArns ??
        (process.env.SES_SNS_TOPIC_ARN ?? '')
          .split(',')
          .map((arn) => arn.trim())
          .filter(Boolean)
      if (
        typeof message.TopicArn !== 'string' ||
        !topicArns.includes(message.TopicArn)
      ) {
        return { ok: false, reason: 'unexpected_topic' }
      }
      const timestamp =
        typeof message.Timestamp === 'string'
          ? Date.parse(message.Timestamp)
          : NaN
      if (
        !Number.isFinite(timestamp) ||
        nowMs - timestamp > DEFAULT_SNS_MAX_AGE_MS ||
        timestamp - nowMs > SNS_CLOCK_SKEW_MS
      ) {
        return { ok: false, reason: 'invalid_timestamp' }
      }
      const requiredFields = ['Message', 'MessageId']
      if (message.Type !== 'Notification')
        requiredFields.push('Token', 'SubscribeURL')
      if (
        requiredFields.some((field) => typeof message[field] !== 'string') ||
        (message.Subject !== undefined &&
          typeof message.Subject !== 'string') ||
        [
          message.MessageId,
          message.Timestamp,
          message.Token,
          message.SubscribeURL,
        ].some((field) => typeof field === 'string' && /[\r\n]/.test(field))
      ) {
        return { ok: false, reason: 'missing_signing_fields' }
      }
      const cached = cache.get(certUrl)
      const pem =
        cached !== undefined && nowMs - cached.fetchedAtMs < cacheTtlMs
          ? cached.pem
          : await fetchCertWithCache(certUrl, fetchCert, cache, nowMs)
      if (pem === null) {
        return { ok: false, reason: 'cert_fetch_failed' }
      }

      try {
        const stringToSign = buildSignableString(message)
        const publicKey = crypto.createPublicKey(pem)
        const valid = crypto.verify(
          algorithm,
          Buffer.from(stringToSign, 'utf8'),
          publicKey,
          Buffer.from(message.Signature, 'base64')
        )
        return valid ? { ok: true } : { ok: false, reason: 'invalid_signature' }
      } catch {
        return { ok: false, reason: 'invalid_signature' }
      }
    },
  }
}

function isDisallowedCertUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return true
  }
  return (
    parsed.protocol !== 'https:' ||
    Boolean(
      parsed.port ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) ||
    !SNS_SIGNING_CERT_HOST_RE.test(parsed.hostname) ||
    !/^\/SimpleNotificationService-[a-z0-9]+\.pem$/i.test(parsed.pathname)
  )
}

async function fetchCertWithCache(
  url: string,
  fetchCert: (url: string) => Promise<string>,
  cache: Map<string, CacheEntry>,
  nowMs: number
): Promise<string | null> {
  try {
    const pem = await fetchCert(url)
    cache.set(url, { pem, fetchedAtMs: nowMs })
    return pem
  } catch {
    // Fail closed and do not cache the failure — SNS retries deliveries, and
    // the next attempt deserves a genuine fetch, not a stale "it failed".
    return null
  }
}

// Prevent accidental non-AWS certificate URLs from being treated as valid by
// code that imports the regex directly.
export const isAllowedSigningCertHost = (hostname: string): boolean =>
  SNS_SIGNING_CERT_HOST_RE.test(hostname)

/** Confirm only after verifying the envelope and its topic. */
export async function confirmSnsSubscription(
  message: SnsMessage
): Promise<void> {
  const url = new URL('/', message.SigningCertURL)
  url.search = new URLSearchParams({
    Action: 'ConfirmSubscription',
    TopicArn: String(message.TopicArn),
    Token: String(message.Token),
  }).toString()
  const response = await fetch(url, {
    signal: AbortSignal.timeout(DEFAULT_CERT_FETCH_TIMEOUT_MS),
    redirect: 'error',
  })
  await response.body?.cancel()
  if (!response.ok) {
    throw new Error(
      `SNS subscription confirmation failed with HTTP ${response.status}`
    )
  }
}
