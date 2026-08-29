import { createHmac, randomBytes } from 'node:crypto'
import { config } from '../config'

const SESSION_LINK_TTL_MS = 15 * 60 * 1000

/** Signed single-use deep link token for new-session alerts (#376). */
export function createSessionDeepLinkToken(
  userId: string,
  sessionId: string
): string {
  const nonce = randomBytes(16).toString('hex')
  const expiresAt = Date.now() + SESSION_LINK_TTL_MS
  const payload = `${userId}:${sessionId}:${nonce}:${expiresAt}`
  const sig = createHmac('sha256', config.jwt.seed)
    .update(payload)
    .digest('hex')
  return Buffer.from(`${payload}:${sig}`).toString('base64url')
}

export function verifySessionDeepLinkToken(
  token: string
): { userId: string; sessionId: string } | null {
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf8')
    const parts = decoded.split(':')
    if (parts.length !== 5) return null
    const [userId, sessionId, , expiresAtStr, sig] = parts
    const expiresAt = parseInt(expiresAtStr, 10)
    if (Date.now() > expiresAt) return null

    const payload = `${userId}:${sessionId}:${parts[2]}:${expiresAtStr}`
    const expected = createHmac('sha256', config.jwt.seed)
      .update(payload)
      .digest('hex')
    if (sig !== expected) return null

    return { userId, sessionId }
  } catch {
    return null
  }
}
