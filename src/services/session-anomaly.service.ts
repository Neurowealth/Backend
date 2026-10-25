import { logger } from '../utils/logger'
import { parseDeviceType } from '../utils/deviceType'
import { resolveApproxLocation, maskIpAddress } from '../utils/geoip'
import { publishUserEvent } from '../events/publisher'
import { closeUserSockets } from '../ws/server'
import { revokeSession } from './refresh-token.service'

export type SessionAnomalyHeuristic =
  | 'IMPOSSIBLE_LOCATION_HOP'
  | 'SUSPICIOUS_DEVICE_TYPE_CHANGE'
  | 'SUBNET_JUMP_ANOMALY'

export interface SessionAnomalyResult {
  isAnomalous: boolean
  heuristic?: SessionAnomalyHeuristic
  details?: string
}

export interface SessionData {
  id: string
  userId: string
  ipAddress?: string | null
  userAgent?: string | null
  deviceType?: string | null
  approxLocation?: string | null
  lastSeenAt?: Date | null
  lastSeenIp?: string | null
  createdAt: Date
  revokedAt?: Date | null
}

export interface RequestContext {
  ip?: string | null
  userAgent?: string | null
}

/** Configurable threshold parameters */
const LOCATION_HOP_MIN_MINUTES = 15 // Impossible to travel between different locations in < 15 mins
const SUBNET_JUMP_WINDOW_MS = 60_000 // 60 seconds

/** Extract /16 subnet prefix for IPv4 or IPv6 */
function extractSubnetPrefix(ip: string | null | undefined): string | null {
  if (!ip) return null
  if (ip.includes(':')) {
    const parts = ip.split(':')
    return parts.slice(0, 3).join(':')
  }
  const octets = ip.split('.')
  if (octets.length >= 2) {
    return `${octets[0]}.${octets[1]}`
  }
  return ip
}

/**
 * Pure evaluation function for session anomalies.
 * Time Complexity: O(1)
 * Space Complexity: O(1)
 */
export function detectSessionAnomaly(
  session: SessionData,
  reqContext: RequestContext
): SessionAnomalyResult {
  const currentIp = reqContext.ip ?? null
  const currentUserAgent = reqContext.userAgent ?? null
  const currentDeviceType = parseDeviceType(currentUserAgent)
  const currentLocation = resolveApproxLocation(currentIp)

  const lastActiveTime = session.lastSeenAt ?? session.createdAt
  const elapsedMinutes =
    (Date.now() - new Date(lastActiveTime).getTime()) / (1000 * 60)

  // 1. IMPOSSIBLE_LOCATION_HOP
  // Location changed within unrealistic travel window
  if (
    currentLocation &&
    session.approxLocation &&
    currentLocation !== session.approxLocation &&
    elapsedMinutes < LOCATION_HOP_MIN_MINUTES
  ) {
    return {
      isAnomalous: true,
      heuristic: 'IMPOSSIBLE_LOCATION_HOP',
      details: `Location changed from "${session.approxLocation}" to "${currentLocation}" in ${Math.round(elapsedMinutes)} minutes`,
    }
  }

  // 2. SUSPICIOUS_DEVICE_TYPE_CHANGE
  // Incompatible device category shift mid-session (e.g. web/ios -> cli)
  const initialDeviceType = session.deviceType ?? 'unknown'
  if (
    initialDeviceType !== 'unknown' &&
    currentDeviceType !== 'unknown' &&
    initialDeviceType !== currentDeviceType
  ) {
    // Shifting from browser/mobile to CLI or across mobile platforms on exact same session token
    if (
      currentDeviceType === 'cli' ||
      initialDeviceType === 'cli' ||
      (initialDeviceType === 'ios' && currentDeviceType === 'android') ||
      (initialDeviceType === 'android' && currentDeviceType === 'ios')
    ) {
      return {
        isAnomalous: true,
        heuristic: 'SUSPICIOUS_DEVICE_TYPE_CHANGE',
        details: `Device type changed mid-session from "${initialDeviceType}" to "${currentDeviceType}"`,
      }
    }
  }

  // 3. SUBNET_JUMP_ANOMALY
  // Rapid IP jump across non-adjacent subnets within SUBNET_JUMP_WINDOW_MS
  const lastIp = session.lastSeenIp ?? session.ipAddress
  const elapsedTimeMs = Date.now() - new Date(lastActiveTime).getTime()
  if (
    currentIp &&
    lastIp &&
    currentIp !== lastIp &&
    elapsedTimeMs < SUBNET_JUMP_WINDOW_MS
  ) {
    const currentSubnet = extractSubnetPrefix(currentIp)
    const lastSubnet = extractSubnetPrefix(lastIp)
    if (currentSubnet && lastSubnet && currentSubnet !== lastSubnet) {
      return {
        isAnomalous: true,
        heuristic: 'SUBNET_JUMP_ANOMALY',
        details: `Subnet jumped from "${lastSubnet}.x" to "${currentSubnet}.x" in ${Math.round(elapsedTimeMs / 1000)}s`,
      }
    }
  }

  return { isAnomalous: false }
}

/**
 * Evaluates session for anomaly and executes forced revocation + security audit if anomalous.
 * Returns true if anomalous (session revoked & handled), false if clean.
 */
export async function evaluateAndHandleSessionAnomaly(
  session: SessionData,
  reqContext: RequestContext
): Promise<boolean> {
  const result = detectSessionAnomaly(session, reqContext)
  if (!result.isAnomalous || !result.heuristic) {
    return false
  }

  logger.warn(
    '[Security] Session anomaly detected — triggering forced logout',
    {
      sessionId: session.id,
      userId: session.userId,
      heuristic: result.heuristic,
      details: result.details,
      ip: maskIpAddress(reqContext.ip),
      userAgent: reqContext.userAgent,
    }
  )

  // 1. Revoke session in DB & clear refresh material
  await revokeSession(session.id, `session_anomaly:${result.heuristic}`, {
    userId: session.userId,
    deviceType: session.deviceType,
    approxLocation: session.approxLocation,
  })

  // 2. Immediate WebSocket disconnect
  closeUserSockets(
    session.userId,
    `Session revoked due to anomaly (${result.heuristic})`
  )

  // 3. Emit security audit event
  publishUserEvent(session.userId, 'alerts', 'security.session_anomaly', {
    sessionId: session.id,
    heuristic: result.heuristic,
    details: result.details ?? null,
    ipAddress: maskIpAddress(reqContext.ip),
    userAgent: reqContext.userAgent ?? null,
    approxLocation: resolveApproxLocation(reqContext.ip),
    revokedAt: new Date().toISOString(),
  }).catch((err) =>
    logger.warn('[Security] Failed to emit security.session_anomaly event', {
      err,
    })
  )

  return true
}
