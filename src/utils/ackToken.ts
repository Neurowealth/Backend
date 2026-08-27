import crypto from 'node:crypto'

const ACK_TOKEN_SECRET =
  process.env.JWT_SECRET || 'neuro-ack-token-secret-key-32b'
const usedAckTokens = new Set<string>()

export interface AckTokenPayload {
  ruleId: string
  fireId: string
  userId: string
  exp: number
}

export function signAckToken(
  ruleId: string,
  fireId: string,
  userId: string,
  ttlSeconds = 86400
): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds
  const payload: AckTokenPayload = { ruleId, fireId, userId, exp }
  const payloadStr = JSON.stringify(payload)
  const sig = crypto
    .createHmac('sha256', ACK_TOKEN_SECRET)
    .update(payloadStr)
    .digest('base64url')
  return `${Buffer.from(payloadStr).toString('base64url')}.${sig}`
}

export function verifyAckToken(token: string): AckTokenPayload | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 2) return null
    const [b64, sig] = parts
    const payloadStr = Buffer.from(b64, 'base64url').toString('utf8')
    const expectedSig = crypto
      .createHmac('sha256', ACK_TOKEN_SECRET)
      .update(payloadStr)
      .digest('base64url')

    if (sig !== expectedSig) return null

    const payload: AckTokenPayload = JSON.parse(payloadStr)
    if (payload.exp < Math.floor(Date.now() / 1000)) return null

    if (usedAckTokens.has(token)) {
      // Idempotent: return payload so repeated call returns 200 without duplicate processing
      return payload
    }

    usedAckTokens.add(token)
    return payload
  } catch {
    return null
  }
}
