import {
  Router,
  Request,
  Response,
  NextFunction,
  RequestHandler,
} from 'express'
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from '@simplewebauthn/server'
import { requireAuth } from '../middleware/authenticate'
import { validate } from '../middleware/validate'
import db from '../db'
import { notifySecurityEvent } from '../services/security-notification.service'
import {
  issueTokenPair,
  newRefreshTokenFields,
} from '../services/refresh-token.service'
import {
  getActiveTotpCredential,
  issueTotpChallenge,
} from '../services/totp.service'
import {
  webAuthnConfig,
  storeWebAuthnChallenge,
  consumeWebAuthnChallenge,
} from '../services/webauthn.service'
import { publishUserEvent as publish } from '../events/publisher'
import { logger } from '../utils/logger'
import { parseDeviceType } from '../utils/deviceType'
import { resolveApproxLocation } from '../utils/geoip'
import { createSessionDeepLinkToken } from '../utils/sessionDeepLink'
import {
  registerOptionsSchema,
  registerVerifySchema,
  loginOptionsSchema,
  loginVerifySchema,
  credentialIdParamSchema,
} from '../validators/webauthn-validators'

const router = Router()
const publishUserEvent = (...args: Parameters<typeof publish>) =>
  publish(...args).catch((error) => {
    logger.warn('[WebAuthn] Failed to publish security notification', {
      error: error instanceof Error ? error.message : String(error),
    })
  })
const handle =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    void fn(req, res).catch(next)
  }
const activeSession: RequestHandler = (req, res, next) => {
  if (req.authKind !== 'session' || !req.auth?.sessionId) {
    res
      .status(401)
      .json({ error: 'An active wallet-established session is required' })
    return
  }
  next()
}

router.post(
  '/register-options',
  requireAuth,
  activeSession,
  validate({ body: registerOptionsSchema }),
  handle(async (req, res) => {
    const user = await db.user.findUnique({ where: { id: req.auth!.userId } })
    if (!user?.isActive || !user.walletAddress) {
      res.status(401).json({ error: 'Wallet-established account required' })
      return
    }
    const { rpID, rpName } = webAuthnConfig()
    const credentials = await db.webAuthnCredential.findMany({
      where: { userId: user.id },
    })
    const options = await generateRegistrationOptions({
      rpID,
      rpName,
      userID: new Uint8Array(Buffer.from(user.id)),
      userName: user.email || user.walletAddress,
      attestationType: 'none',
      excludeCredentials: credentials.map((c) => ({ id: c.credentialId })),
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required',
      },
    })
    await storeWebAuthnChallenge(
      options.challenge,
      'register',
      user.id,
      req.auth!.sessionId
    )
    res.json({ options, challengeId: options.challenge })
  })
)

router.post(
  '/register-verify',
  requireAuth,
  activeSession,
  validate({ body: registerVerifySchema }),
  handle(async (req, res) => {
    const { challengeId, response, deviceLabel } = registerVerifySchema.parse(
      req.body
    )
    const userId = req.auth!.userId
    if (
      !(await consumeWebAuthnChallenge(
        challengeId,
        'register',
        userId,
        req.auth!.sessionId
      ))
    ) {
      res.status(400).json({ error: 'Challenge expired or already used' })
      return
    }
    const { rpID, origin } = webAuthnConfig()
    let result
    try {
      result = await verifyRegistrationResponse({
        response: response as RegistrationResponseJSON,
        expectedChallenge: challengeId,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: true,
      })
    } catch {
      res
        .status(400)
        .json({ error: 'Passkey registration verification failed' })
      return
    }
    if (!result.verified || !result.registrationInfo) {
      res
        .status(400)
        .json({ error: 'Passkey registration verification failed' })
      return
    }
    const { credential } = result.registrationInfo
    const created = await db.webAuthnCredential.create({
      data: {
        userId,
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString('base64'),
        signCount: BigInt(credential.counter),
        deviceLabel: deviceLabel || 'Passkey',
        transports: credential.transports || [],
      },
    })
    await notifySecurityEvent(userId, 'passkey.registered', {
      credentialId: created.credentialId,
    })
    await publishUserEvent(userId, 'alerts', 'security.passkey_changed', {
      action: 'registered',
      credentialId: created.credentialId,
    })
    res.status(201).json({ verified: true, credentialId: created.credentialId })
  })
)

router.post(
  '/login-options',
  validate({ body: loginOptionsSchema }),
  handle(async (req, res) => {
    const { userId } = loginOptionsSchema.parse(req.body)
    const { rpID } = webAuthnConfig()
    const credentials = userId
      ? await db.webAuthnCredential.findMany({ where: { userId } })
      : []
    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: 'required',
      ...(userId
        ? { allowCredentials: credentials.map((c) => ({ id: c.credentialId })) }
        : {}),
    })
    await storeWebAuthnChallenge(options.challenge, 'login', userId)
    res.json({ options, challengeId: options.challenge })
  })
)

router.post(
  '/login-verify',
  validate({ body: loginVerifySchema }),
  handle(async (req, res) => {
    const { userId, challengeId, response } = loginVerifySchema.parse(req.body)
    const credential = await db.webAuthnCredential.findUnique({
      where: { credentialId: response.id },
      include: { user: true },
    })
    if (
      !credential?.user.isActive ||
      (userId && userId !== credential.userId)
    ) {
      res.status(401).json({ error: 'Invalid credential' })
      return
    }
    if (
      !(await consumeWebAuthnChallenge(challengeId, 'login', credential.userId))
    ) {
      res.status(400).json({ error: 'Challenge expired or already used' })
      return
    }
    const { rpID, origin } = webAuthnConfig()
    let result
    try {
      result = await verifyAuthenticationResponse({
        response: response as AuthenticationResponseJSON,
        expectedChallenge: challengeId,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: true,
        credential: {
          id: credential.credentialId,
          publicKey: new Uint8Array(
            Buffer.from(credential.publicKey, 'base64')
          ),
          counter: Number(credential.signCount),
        },
      })
    } catch (err) {
      if (
        err instanceof Error &&
        /Response counter value .* was lower than expected/.test(err.message)
      ) {
        await notifySecurityEvent(credential.userId, 'passkey.anomaly', {
          credentialId: credential.credentialId,
          reason: 'sign_count_anomaly',
        })
        await publishUserEvent(
          credential.userId,
          'alerts',
          'security.passkey_anomaly',
          {
            credentialId: credential.credentialId,
            reason: 'sign_count_anomaly',
          }
        )
      }
      res.status(401).json({ error: 'Passkey authentication failed' })
      return
    }
    if (!result.verified) {
      res.status(401).json({ error: 'Passkey authentication failed' })
      return
    }
    const newCounter = BigInt(result.authenticationInfo.newCounter)
    if (
      (newCounter > 0n || credential.signCount > 0n) &&
      newCounter <= credential.signCount
    ) {
      await notifySecurityEvent(credential.userId, 'passkey.anomaly', {
        credentialId: credential.credentialId,
      })
      await publishUserEvent(
        credential.userId,
        'alerts',
        'security.passkey_anomaly',
        { credentialId: credential.credentialId }
      )
      res.status(401).json({ error: 'Authenticator counter anomaly' })
      return
    }
    // Compare-and-swap also protects concurrent assertions for a counting authenticator.
    const updated = await db.webAuthnCredential.updateMany({
      where: { id: credential.id, signCount: credential.signCount },
      data: { signCount: newCounter, lastUsedAt: new Date() },
    })
    if (!updated.count) {
      res.status(401).json({ error: 'Credential was changed; retry login' })
      return
    }
    const totp = await getActiveTotpCredential(credential.userId)
    if (totp?.verifiedAt) {
      const challenge = await issueTotpChallenge(credential.userId, {
        stellarPubKey: credential.user.walletAddress,
        userAgent: req.headers['user-agent'] ?? null,
        ipAddress: req.ip ?? null,
      })
      res.json({
        requiresTotp: true,
        totpChallengeToken: challenge.token,
        totpExpiresAt: challenge.expiresAt.toISOString(),
      })
      return
    }
    const pair = await issueTokenPair(credential.userId)
    const userAgent = req.headers['user-agent'] ?? null
    const ipAddress = req.ip ?? null
    const deviceType = parseDeviceType(userAgent)
    const approxLocation = resolveApproxLocation(ipAddress)
    const session = await db.session.create({
      data: {
        userId: credential.userId,
        token: pair.accessToken,
        walletAddress: credential.user.walletAddress,
        network: credential.user.network,
        expiresAt: pair.expiresAt,
        ipAddress,
        userAgent,
        deviceType,
        approxLocation,
        lastSeenAt: new Date(),
        lastSeenIp: ipAddress,
        ...newRefreshTokenFields(pair),
      },
    })
    const deepLinkToken = createSessionDeepLinkToken(
      credential.userId,
      session.id
    )
    await publishUserEvent(
      credential.userId,
      'alerts',
      'security.new_session',
      {
        sessionId: session.id,
        deviceType,
        approxLocation,
        ipAddress: ipAddress ? `${ipAddress.slice(0, -3)}xxx` : null,
        createdAt: session.createdAt.toISOString(),
        revokeLink: `/sessions?highlight=${session.id}&token=${deepLinkToken}`,
      }
    )
    res.json({
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      userId: credential.userId,
      expiresAt: pair.expiresAt.toISOString(),
      refreshExpiresAt: pair.refreshExpiresAt.toISOString(),
    })
  })
)

router.get(
  '/credentials',
  requireAuth,
  activeSession,
  handle(async (req, res) => {
    const credentials = await db.webAuthnCredential.findMany({
      where: { userId: req.auth!.userId },
      select: {
        id: true,
        credentialId: true,
        deviceLabel: true,
        transports: true,
        createdAt: true,
        lastUsedAt: true,
      },
      orderBy: { createdAt: 'desc' },
    })
    res.json({ credentials })
  })
)

router.delete(
  '/credentials/:id',
  requireAuth,
  activeSession,
  validate({ params: credentialIdParamSchema }),
  handle(async (req, res) => {
    const result = await db.webAuthnCredential.deleteMany({
      where: { id: req.params.id, userId: req.auth!.userId },
    })
    if (!result.count) {
      res.status(404).json({ error: 'Credential not found' })
      return
    }
    await notifySecurityEvent(req.auth!.userId, 'passkey.deleted', {
      credentialId: req.params.id,
    })
    await publishUserEvent(
      req.auth!.userId,
      'alerts',
      'security.passkey_changed',
      { action: 'deleted', credentialId: req.params.id }
    )
    res.json({ deleted: true })
  })
)

export default router
