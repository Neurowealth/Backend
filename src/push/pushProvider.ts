import { logger } from '../utils/logger'
import { createPrivateKey, createSign } from 'node:crypto'
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
 * Mock Push Provider for local testing & development.
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
    logger.info(
      `[MockPushProvider] Sent push to ${message.deviceToken}: ${message.title}`
    )
    return { messageId, provider: this.name, success: true }
  }
}

export class FcmPushProvider implements PushProvider {
  name = 'fcm'

  async send(message: PushMessage): Promise<PushSendResult> {
    // A missing credential is a deployment problem, not a delivery failure,
    // so it throws instead of returning success: false.
    const serverKey = process.env.FCM_SERVER_KEY
    if (!serverKey) {
      throw new Error('FCM provider not configured: FCM_SERVER_KEY missing')
    }

    try {
      const response = await fetch('https://fcm.googleapis.com/fcm/send', {
        method: 'POST',
        headers: {
          Authorization: `key=${serverKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          to: message.deviceToken,
          notification: { title: message.title, body: message.body },
          ...(message.data ? { data: message.data } : {}),
        }),
      })
      const result = (await response.json()) as {
        message_id?: string
        error?: string
      }
      if (!response.ok || !result.message_id) {
        throw new Error(
          result.error || `FCM returned HTTP ${response.status} without a message ID`
        )
      }

      const messageId = result.message_id
      logger.info(
        `[FcmPushProvider] Sent push via FCM to ${message.deviceToken}`,
        {
          messageId,
        }
      )

      return { messageId, provider: this.name, success: true }
    } catch (err) {
      logger.error('[FcmPushProvider] Failed to send push via FCM', {
        error: err instanceof Error ? err.message : String(err),
      })
      return {
        messageId: `push_fcm_${Date.now()}`,
        provider: this.name,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      }
    }
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
      const result = await sendApnsRequest(host, message.deviceToken, {
        authorization: `bearer ${token}`,
        'apns-topic': bundleId,
        'apns-push-type': 'alert',
        'content-type': 'application/json',
      }, {
        aps: { alert: { title: message.title, body: message.body } },
        ...(message.data ?? {}),
      })
      if (result.status < 200 || result.status >= 300 || !result.apnsId) {
        throw new Error(
          result.reason || `APNs returned HTTP ${result.status} without an ID`
        )
      }

      const messageId = result.apnsId
      logger.info(
        `[ApnsPushProvider] Sent push via APNs to ${message.deviceToken}`,
        {
          messageId,
        }
      )

      return { messageId, provider: this.name, success: true }
    } catch (err) {
      logger.error('[ApnsPushProvider] Failed to send push via APNs', {
        error: err instanceof Error ? err.message : String(err),
      })
      return {
        messageId: `push_apns_${Date.now()}`,
        provider: this.name,
        success: false,
        error: err instanceof Error ? err.message : String(err),
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
    const mockProvider = new MockPushProvider()
    const fcmProvider = new FcmPushProvider()
    const apnsProvider = new ApnsPushProvider()

    this.providers.set('mock', mockProvider)
    // Android and web both go through FCM, so they share one instance
    this.providers.set('android', fcmProvider)
    this.providers.set('web', fcmProvider)
    this.providers.set('ios', apnsProvider)

    logger.info('[PushRegistry] Initialized', {
      providers: Array.from(this.providers.keys()),
    })
  }

  /**
   * Find the provider for a platform (case-insensitive). Unknown platforms
   * fall back to the mock provider with a warning, so nothing is really
   * delivered to them. Make sure that is acceptable in production.
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
  const signer = createSign('SHA256')
  signer.update(`${header}.${payload}`)
  const signature = derSignatureToJose(
    signer.sign(createPrivateKey(privateKey))
  ).toString('base64url')
  return `${header}.${payload}.${signature}`
}

function derSignatureToJose(signature: Buffer): Buffer {
  let offset = 2
  if (signature[1] & 0x80) offset += signature[1] & 0x7f
  if (signature[offset++] !== 0x02) throw new Error('Invalid APNs signature')
  const rLength = signature[offset++]
  const r = signature.subarray(offset, offset + rLength)
  offset += rLength
  if (signature[offset++] !== 0x02) throw new Error('Invalid APNs signature')
  const sLength = signature[offset++]
  const s = signature.subarray(offset, offset + sLength)
  const normalize = (value: Buffer): Buffer => {
    let normalized = value
    while (normalized.length > 32 && normalized[0] === 0) {
      normalized = normalized.subarray(1)
    }
    return Buffer.concat([Buffer.alloc(32 - normalized.length), normalized])
  }
  return Buffer.concat([normalize(r), normalize(s)])
}

function sendApnsRequest(
  host: string,
  deviceToken: string,
  headers: Record<string, string>,
  body: Record<string, unknown>
): Promise<{ status: number; apnsId?: string; reason?: string }> {
  return new Promise((resolve, reject) => {
    const client = http2.connect(`https://${host}`)
    client.once('error', reject)
    const request = client.request({
      ':method': 'POST',
      ':path': `/3/device/${encodeURIComponent(deviceToken)}`,
      ...headers,
    })
    let responseBody = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => {
      responseBody += chunk
    })
    request.on('response', (responseHeaders) => {
      request.on('end', () => {
        client.close()
        let parsed: { reason?: string } = {}
        if (responseBody) {
          try {
            parsed = JSON.parse(responseBody) as { reason?: string }
          } catch {
            parsed = {}
          }
        }
        resolve({
          status: Number(responseHeaders[':status']),
          apnsId: responseHeaders['apns-id']?.toString(),
          reason: parsed.reason,
        })
      })
    })
    request.on('error', (error) => {
      client.close()
      reject(error)
    })
    request.end(JSON.stringify(body))
  })
}
