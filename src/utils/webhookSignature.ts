import { createHmac, randomBytes, timingSafeEqual } from 'crypto'

/**
 * Generate a cryptographically secure webhook signing secret.
 */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString('hex')
}

/**
 * Sign a webhook payload with HMAC-SHA256 (v1).
 * Returns the hex digest prefixed with "sha256=".
 */
export function signPayload(secret: string, payload: string): string {
  const hmac = createHmac('sha256', secret)
  hmac.update(payload)
  return `sha256=${hmac.digest('hex')}`
}

/**
 * v2 signature over "timestamp.deliveryId.body" (#377).
 */
export function signPayloadV2(
  secret: string,
  timestamp: number,
  deliveryId: string,
  body: string
): string {
  const signedString = `${timestamp}.${deliveryId}.${body}`
  const hmac = createHmac('sha256', secret)
  hmac.update(signedString)
  return hmac.digest('hex')
}

/** Build combined v1+v2 signature header value. */
export function buildSignatureHeader(
  secrets: string[],
  payload: string,
  timestamp: number,
  deliveryId: string
): string {
  const parts: string[] = []
  for (const secret of secrets) {
    const v2 = signPayloadV2(secret, timestamp, deliveryId, payload)
    parts.push(`v2,${v2}`)
  }
  if (process.env.WEBHOOK_SEND_V1_SIGNATURE !== 'false') {
    parts.push(`v1,${signPayload(secrets[0], payload).replace('sha256=', '')}`)
  }
  return parts.join(' ')
}

/** Verify v2 signature (for docs/tests). */
export function verifyPayloadV2(
  secret: string,
  timestamp: number,
  deliveryId: string,
  body: string,
  hexSig: string,
  toleranceSec = 300
): boolean {
  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - timestamp) > toleranceSec) return false

  const expected = signPayloadV2(secret, timestamp, deliveryId, body)
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(hexSig))
  } catch {
    return false
  }
}
