import { createHmac, randomBytes } from 'crypto'

/**
 * Generate a cryptographically secure webhook signing secret.
 */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString('hex')
}

/**
 * Sign a webhook payload with HMAC-SHA256.
 * Returns the hex digest prefixed with "sha256=".
 */
export function signPayload(secret: string, payload: string): string {
  const hmac = createHmac('sha256', secret)
  hmac.update(payload)
  return `sha256=${hmac.digest('hex')}`
}
