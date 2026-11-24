import { logger } from '../utils/logger'
import { sign } from 'node:crypto'
import jwt from 'jsonwebtoken'
import http2 from 'node:http2'

/**
 * A single push notification addressed to one device.
 */
export interface PushMessage {
  deviceToken: string // Provider-specific token identifying the target device
  title: string
  body: string
  data?: Record<string, unknown> // Optional custom payload delivered with the notification
}

/**
 * Outcome of a send attempt. Providers report delivery problems here
 * (success: false with an error message) rather than throwing, except for
 * configuration errors, which are thrown.
 */
export interface PushSendResult {
  messageId: string
  provider: string // Name of the provider that handled the message
  success: boolean
  error?: string // Present only when success is false
}

/**
 * Common interface every push backend implements, so callers don't need to
 * know which service actually delivers the message.
 */
export interface PushProvider {
  name: string
  send(message: PushMessage): Promise<PushSendResult>
}

/**
 * Mock Push Provider for unit tests.
 * Delivers nothing; it records each message so tests can assert on what
 * would have been sent.
 */
export class MockPushProvider implements PushProvider {
  name = 'mock'
  sentMessages: PushMessage[] = []

  async send(message: PushMessage): Promise<PushSendResult> {
    this.sentMessages.push(message)
    if (this.sentMessages.length > 1000) this.sentMessages.shift()
    // Timestamp plus a short random suffix keeps IDs unique within a run
    const messageId = `push_mock_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    logger.info('[MockPushProvider] Recorded push', { messageId })
    return { messageId, provider: this.name, success: true }
  }
}

const PUSH_TIMEOUT_MS = 10_000
const FCM_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const INVALID_PUSH_TOKEN = 'invalid_token'

export class FcmPushProvider implements PushProvider {
  name = 'fcm'
  private credentials?: {
    email: string
    privateKey: string
    accessToken: Promise<string>
    refreshAt: number
  }

  private getAccessToken(email: string, privateKey: string): Promise<string> {
    const cached = this.credentials
    if (
      cached?.email === email &&
      cached.privateKey === privateKey &&
      cached.refreshAt > Date.now()
    ) {
      return cached.accessToken
    }

    const credentials = {
      email,
      privateKey,
      refreshAt: Infinity,
      accessToken: this.requestAccessToken(email, privateKey).then(
        ({ accessToken, expiresIn }) => {
          credentials.refreshAt =
            Date.now() + Math.max(0, expiresIn - 60) * 1000
          return accessToken
        },
        (error: unknown) => {
          if (this.credentials === credentials) this.credentials = undefined
          throw error
        }
      ),
    }
    this.credentials = credentials
    return credentials.accessToken
  }

  private async requestAccessToken(
    email: string,
    privateKey: string
  ): Promise<{ accessToken: string; expiresIn: number }> {
    const assertion = jwt.sign(
      { scope: 'https://www.googleapis.com/auth/firebase.messaging' },
      privateKey,
      {
        algorithm: 'RS256',
        issuer: email,
        audience: FCM_TOKEN_URL,
        expiresIn: '1h',
      }
    )
    const response = await fetch(FCM_TOKEN_URL, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
      redirect: 'error',
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error('FCM authentication failed')
    }
    const result = (await response.json()) as {
      access_token?: string
      expires_in?: number
    }
    if (
      typeof result.access_token !== 'string' ||
      !result.access_token ||
      typeof result.expires_in !== 'number' ||
      !Number.isFinite(result.expires_in)
    ) {
      throw new Error('FCM authentication returned an invalid response')
    }
    return { accessToken: result.access_token, expiresIn: result.expires_in }
  }

  async send(message: PushMessage): Promise<PushSendResult> {
    const projectId = process.env.FCM_PROJECT_ID
    const email = process.env.FCM_CLIENT_EMAIL
    const privateKey = process.env.FCM_PRIVATE_KEY?.replace(/\\n/g, '\n')
    if (!projectId || !email || !privateKey) {
      throw new Error(
        'FCM requires FCM_PROJECT_ID, FCM_CLIENT_EMAIL, and FCM_PRIVATE_KEY'
      )
    }

    try {
      const accessToken = await this.getAccessToken(email, privateKey)
      const response = await fetch(
        `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            message: {
              token: message.deviceToken,
              notification: { title: message.title, body: message.body },
              data:
                message.data &&
                Object.fromEntries(
                  Object.entries(message.data).map(([key, value]) => [
                    key,
                    typeof value === 'string' ? value : JSON.stringify(value),
                  ])
                ),
            },
          }),
          signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
          redirect: 'error',
        }
      )
      const result = (await response.json().catch(() => null)) as {
        name?: string
        error?: {
          message?: string
          details?: {
            '@type'?: string
            errorCode?: string
            fieldViolations?: { field?: string }[]
          }[]
        }
      } | null
      if (response.ok && typeof result?.name === 'string' && result.name) {
        return { messageId: result.name, provider: this.name, success: true }
      }

      const invalidToken =
        Array.isArray(result?.error?.details) &&
        result.error.details.some((detail) => {
          if (
            detail?.['@type'] ===
            'type.googleapis.com/google.firebase.fcm.v1.FcmError'
          ) {
            return (
              (response.status === 404 &&
                detail.errorCode === 'UNREGISTERED') ||
              (response.status === 400 &&
                detail.errorCode === 'INVALID_ARGUMENT' &&
                result.error?.message ===
                  'The registration token is not a valid FCM registration token')
            )
          }
          return (
            response.status === 400 &&
            detail?.['@type'] === 'type.googleapis.com/google.rpc.BadRequest' &&
            Array.isArray(detail.fieldViolations) &&
            detail.fieldViolations.some(
              (violation) => violation?.field === 'message.token'
            )
          )
        })
      return this.failure(
        invalidToken
          ? INVALID_PUSH_TOKEN
          : `FCM send failed (HTTP ${response.status})`
      )
    } catch {
      return this.failure('FCM push request failed')
    }
  }

  private failure(error: string): PushSendResult {
    return { messageId: '', provider: this.name, success: false, error }
  }
}

export class ApnsPushProvider implements PushProvider {
  name = 'apns'

  async send(message: PushMessage): Promise<PushSendResult> {
    const keyId = process.env.APNS_KEY_ID
    const teamId = process.env.APNS_TEAM_ID
    const privateKey = process.env.APNS_PRIVATE_KEY?.replace(/\\n/g, '\n')
    const bundleId = process.env.APNS_BUNDLE_ID
    if (!keyId || !teamId || !privateKey || !bundleId) {
      throw new Error(
        'APNs provider not configured: APNS_KEY_ID, APNS_TEAM_ID, APNS_PRIVATE_KEY, or APNS_BUNDLE_ID missing'
      )
    }

    try {
      const token = createApnsToken(teamId, keyId, privateKey)
      const host =
        process.env.APNS_USE_SANDBOX === 'true'
          ? 'api.sandbox.push.apple.com'
          : 'api.push.apple.com'
      const result = await sendApnsRequest(
        host,
        message.deviceToken,
        {
          authorization: `bearer ${token}`,
          'apns-topic': bundleId,
          'apns-push-type': 'alert',
          'content-type': 'application/json',
        },
        {
          ...message.data,
          aps: { alert: { title: message.title, body: message.body } },
        }
      )
      if (result.status >= 200 && result.status < 300 && result.apnsId) {
        return { messageId: result.apnsId, provider: this.name, success: true }
      }
      const invalidToken =
        (result.status === 410 && result.reason === 'Unregistered') ||
        (result.status === 400 && result.reason === 'BadDeviceToken')
      return {
        messageId: '',
        provider: this.name,
        success: false,
        error: invalidToken
          ? INVALID_PUSH_TOKEN
          : `APNs send failed (HTTP ${result.status})`,
      }
    } catch {
      return {
        messageId: '',
        provider: this.name,
        success: false,
        error: 'APNs push request failed',
      }
    }
  }
}

/**
 * Push Provider Registry with Platform-based Dispatch.
 * Maps a device platform (android, web, ios, mock) to the provider that
 * should deliver to it.
 */
export class PushRegistry {
  // Keyed by lowercase platform name
  private providers: Map<string, PushProvider> = new Map()

  constructor() {
    const fcmProvider = new FcmPushProvider()
    const apnsProvider = new ApnsPushProvider()

    if (process.env.NODE_ENV === 'test') {
      this.providers.set('mock', new MockPushProvider())
    }
    // Android and web both go through FCM, so they share one instance
    this.providers.set('android', fcmProvider)
    this.providers.set('web', fcmProvider)
    this.providers.set('ios', apnsProvider)

    logger.info('[PushRegistry] Initialized', {
      providers: Array.from(this.providers.keys()),
    })
  }

  /**
   * Find the provider for a supported platform (case-insensitive).
   */
  getProvider(platform: string): PushProvider {
    const provider = this.providers.get(platform.toLowerCase())
    if (!provider) {
      throw new Error(`No push provider configured for platform "${platform}"`)
    }
    return provider
  }

  /**
   * Send a message using the provider that matches the device's platform.
   * May throw if the chosen provider is not configured.
   */
  async send(platform: string, message: PushMessage): Promise<PushSendResult> {
    const provider = this.getProvider(platform)
    return provider.send(message)
  }
}

// Shared singleton used across the app
export const pushRegistry = new PushRegistry()

function createApnsToken(
  teamId: string,
  keyId: string,
  privateKey: string
): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'ES256', kid: keyId })
  ).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({ iss: teamId, iat: Math.floor(Date.now() / 1000) })
  ).toString('base64url')
  const signature = sign('SHA256', Buffer.from(`${header}.${payload}`), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url')
  return `${header}.${payload}.${signature}`
}

function sendApnsRequest(
  host: string,
  deviceToken: string,
  headers: Record<string, string>,
  body: Record<string, unknown>
): Promise<{ status: number; apnsId?: string; reason?: string }> {
  return new Promise((resolve, reject) => {
    const client = http2.connect(`https://${host}`)
    const timer = setTimeout(
      () => fail(new Error('APNs request timed out')),
      PUSH_TIMEOUT_MS
    )
    function fail(error: Error): void {
      clearTimeout(timer)
      client.destroy()
      reject(error)
    }

    client.once('error', fail)
    try {
      const request = client.request({
        ':method': 'POST',
        ':path': `/3/device/${encodeURIComponent(deviceToken)}`,
        ...headers,
      })
      let responseBody = ''
      let responseHeaders: http2.IncomingHttpHeaders | undefined
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => {
        responseBody += chunk
      })
      request.once('response', (headers) => {
        responseHeaders = headers
      })
      request.once('error', fail)
      request.once('aborted', () => fail(new Error('APNs request aborted')))
      request.once('end', () => {
        clearTimeout(timer)
        client.close()
        let reason: string | undefined
        try {
          reason = (JSON.parse(responseBody) as { reason?: string } | null)
            ?.reason
        } catch {
          // APNs acknowledgements have an empty body.
        }
        resolve({
          status: Number(responseHeaders?.[':status']),
          apnsId: responseHeaders?.['apns-id']?.toString(),
          reason,
        })
      })
      request.end(JSON.stringify(body))
    } catch (error) {
      fail(error instanceof Error ? error : new Error('APNs request failed'))
    }
  })
}
