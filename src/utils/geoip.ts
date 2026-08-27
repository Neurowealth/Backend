/** Offline coarse geo from IP — city/country only, no third-party calls (#376). */

const PRIVATE_IP =
  /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1|fc00:|fd)/

/** Minimal offline lookup table for common ranges; returns null when unknown. */
const GEO_HINTS: Array<{ prefix: string; location: string }> = [
  { prefix: '8.8.', location: 'Mountain View, US' },
  { prefix: '1.1.', location: 'Sydney, AU' },
]

export function resolveApproxLocation(
  ip: string | null | undefined
): string | null {
  if (!ip || PRIVATE_IP.test(ip)) return null

  for (const hint of GEO_HINTS) {
    if (ip.startsWith(hint.prefix)) return hint.location
  }

  return null
}

/** Mask IP to /24 (hide last octet for IPv4). */
export function maskIpAddress(ip: string | null | undefined): string | null {
  if (!ip) return null
  if (ip.includes(':')) {
    const parts = ip.split(':')
    return parts.slice(0, 4).join(':') + '::'
  }
  const octets = ip.split('.')
  if (octets.length === 4) {
    return `${octets[0]}.${octets[1]}.${octets[2]}.xxx`
  }
  return ip
}
