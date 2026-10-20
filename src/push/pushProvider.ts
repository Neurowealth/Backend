import { logger } from '../utils/logger'

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
  // Every message passed to send(), in order, for test assertions
  sentMessages: PushMessage[] = []

  async send(message: PushMessage): Promise<PushSendResult> {
    this.sentMessages.push(message)
    // Timestamp plus a short random suffix keeps IDs unique within a run
    const messageId = `push_mock_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    logger.info(
      `[MockPushProvider] Sent push to ${message.deviceToken}: ${message.title}`
    )
    return { messageId, provider: this.name, success: true }
  }
}

/**
 * FCM Push Provider for Android and Web Push.
 *
 * NOTE: This is currently a stub. It checks configuration and logs, but never
 * calls FCM, so it always reports success. A real HTTP call to FCM needs to be
 * added inside the try block.
 */
export class FcmPushProvider implements PushProvider {
  name = 'fcm'

  async send(message: PushMessage): Promise<PushSendResult> {
    // A missing credential is a deployment problem, not a delivery failure,
    // so it throws instead of returning success: false.
    if (!process.env.FCM_SERVER_KEY) {
      throw new Error('FCM provider not configured: FCM_SERVER_KEY missing')
    }

    try {
      // Placeholder ID; no request is actually made to FCM yet
      const messageId = `push_fcm_${Date.now()}`
      logger.info(
        `[FcmPushProvider] Sent push via FCM to ${message.deviceToken}`,
        {
          messageId,
        }
      )

      return { messageId, provider: this.name, success: true }
    } catch (err) {
      // Delivery errors are returned as a failed result so one bad send
      // doesn't crash the caller
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

/**
 * APNs Push Provider for iOS.
 *
 * NOTE: Like FcmPushProvider, this is currently a stub. It validates
 * configuration and logs but does not contact Apple, so it always reports
 * success. It also only checks APNS_KEY_ID and APNS_TEAM_ID; a real
 * implementation will need the signing key and bundle ID as well.
 */
export class ApnsPushProvider implements PushProvider {
  name = 'apns'

  async send(message: PushMessage): Promise<PushSendResult> {
    // As with FCM, missing configuration throws rather than returning a
    // failed result
    if (!process.env.APNS_KEY_ID || !process.env.APNS_TEAM_ID) {
      throw new Error(
        'APNs provider not configured: APNS_KEY_ID or APNS_TEAM_ID missing'
      )
    }

    try {
      // Placeholder ID; no request is actually made to APNs yet
      const messageId = `push_apns_${Date.now()}`
      logger.info(
        `[ApnsPushProvider] Sent push via APNs to ${message.deviceToken}`,
        {
          messageId,
        }
      )

      return { messageId, provider: this.name, success: true }
    } catch (err) {
      // Delivery errors are returned as a failed result, not thrown
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
      logger.warn(
        `[PushRegistry] No provider for platform "${platform}", falling back to mock`
      )
      return this.providers.get('mock')!
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
