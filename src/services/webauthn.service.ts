import db from '../db'

export function webAuthnConfig() {
  const production =
    process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging'
  const rpID = process.env.WEBAUTHN_RP_ID || (production ? '' : 'localhost')
  const origin =
    process.env.WEBAUTHN_ORIGIN || (production ? '' : 'http://localhost:3000')
  if (!rpID || !origin)
    throw new Error('WEBAUTHN_RP_ID and WEBAUTHN_ORIGIN must be configured')
  const url = new URL(origin)
  if (
    url.origin !== origin ||
    (url.hostname !== rpID && !url.hostname.endsWith(`.${rpID}`)) ||
    (url.protocol !== 'https:' &&
      !(rpID === 'localhost' && url.protocol === 'http:'))
  ) {
    throw new Error('Invalid WebAuthn relying-party configuration')
  }
  return { rpID, origin, rpName: process.env.WEBAUTHN_RP_NAME || 'NeuroWealth' }
}

export async function storeWebAuthnChallenge(
  challenge: string,
  purpose: 'register' | 'login',
  userId?: string,
  sessionId?: string
) {
  await db.webAuthnChallenge.deleteMany({
    where: { expiresAt: { lte: new Date() } },
  })
  await db.webAuthnChallenge.create({
    data: {
      challenge,
      purpose,
      userId,
      sessionId,
      expiresAt: new Date(Date.now() + 5 * 60000),
    },
  })
}

export async function consumeWebAuthnChallenge(
  challenge: string,
  purpose: 'register' | 'login',
  userId: string,
  sessionId?: string
) {
  const consumed = await db.webAuthnChallenge.deleteMany({
    where: {
      challenge,
      purpose,
      expiresAt: { gt: new Date() },
      ...(purpose === 'register'
        ? { userId, sessionId }
        : { OR: [{ userId }, { userId: null }] }),
    },
  })
  return consumed.count === 1
}
