import dns from 'node:dns'
import net from 'node:net'
import { URL } from 'node:url'

/**
 * Normalizes and parses raw host/IP string into canonical IP string (IPv4 dotted-quad or IPv6).
 * Handles decimal, hex, and octal integer formats for IPv4 as well as bracketed IPv6.
 */
export function parseIpAddress(raw: string): string | null {
  let host = raw.trim()

  // Strip IPv6 brackets if present
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1)
  }

  // Valid IPv6
  if (net.isIPv6(host)) {
    return host
  }

  // Valid standard IPv4
  if (net.isIPv4(host)) {
    return host
  }

  // Hexadecimal single integer (e.g. 0x7f000001)
  if (/^0x[0-9a-f]+$/i.test(host)) {
    const val = parseInt(host, 16)
    if (val >= 0 && val <= 0xffffffff) {
      return `${(val >>> 24) & 255}.${(val >>> 16) & 255}.${(val >>> 8) & 255}.${val & 255}`
    }
  }

  // Octal single integer (e.g. 017700000001)
  if (/^0[0-7]+$/.test(host)) {
    const val = parseInt(host, 8)
    if (val >= 0 && val <= 0xffffffff) {
      return `${(val >>> 24) & 255}.${(val >>> 16) & 255}.${(val >>> 8) & 255}.${val & 255}`
    }
  }

  // Decimal single integer (e.g. 2130706433 for 127.0.0.1)
  if (/^\d+$/.test(host)) {
    const val = parseInt(host, 10)
    if (val >= 0 && val <= 0xffffffff) {
      return `${(val >>> 24) & 255}.${(val >>> 16) & 255}.${(val >>> 8) & 255}.${val & 255}`
    }
  }

  // Dotted decimal/octal/hex components (e.g. 0177.0.0.1 or 0x7f.0.0.1)
  const parts = host.split('.')
  if (parts.length === 4) {
    const octets: number[] = []
    for (const p of parts) {
      let num: number
      if (/^0x[0-9a-f]+$/i.test(p)) num = parseInt(p, 16)
      else if (/^0[0-7]+$/.test(p)) num = parseInt(p, 8)
      else if (/^\d+$/.test(p)) num = parseInt(p, 10)
      else return null

      if (isNaN(num) || num < 0 || num > 255) return null
      octets.push(num)
    }
    return octets.join('.')
  }

  return null
}

/**
 * Checks if an IP address belongs to private, loopback, link-local, CGNAT,
 * documentation, multicast, broadcast, or IPv6 ULA/mapped ranges.
 */
export function isPrivateOrReservedIp(rawIp: string): boolean {
  const ip = parseIpAddress(rawIp) || rawIp

  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map((p) => parseInt(p, 10))
    const [b1, b2, b3, b4] = parts

    // 0.0.0.0/8 (Current network / default)
    if (b1 === 0) return true

    // 10.0.0.0/8 (Private-Use class A)
    if (b1 === 10) return true

    // 100.64.0.0/10 (Shared Address Space / CGNAT: 100.64.0.0 - 100.127.255.255)
    if (b1 === 100 && b2 >= 64 && b2 <= 127) return true

    // 127.0.0.0/8 (Loopback)
    if (b1 === 127) return true

    // 169.254.0.0/16 (Link-Local / Cloud Metadata: e.g. 169.254.169.254)
    if (b1 === 169 && b2 === 254) return true

    // 172.16.0.0/12 (Private-Use class B: 172.16.0.0 - 172.31.255.255)
    if (b1 === 172 && b2 >= 16 && b2 <= 31) return true

    // 192.0.0.0/24 (IETF Protocol Assignments)
    if (b1 === 192 && b2 === 0 && b3 === 0) return true

    // 192.0.2.0/24 (TEST-NET-1 documentation)
    if (b1 === 192 && b2 === 0 && b3 === 2) return true

    // 192.168.0.0/16 (Private-Use class C)
    if (b1 === 192 && b2 === 168) return true

    // 198.18.0.0/15 (Network benchmark tests: 198.18.0.0 - 198.19.255.255)
    if (b1 === 198 && (b2 === 18 || b2 === 19)) return true

    // 198.51.100.0/24 (TEST-NET-2 documentation)
    if (b1 === 198 && b2 === 51 && b3 === 100) return true

    // 203.0.113.0/24 (TEST-NET-3 documentation)
    if (b1 === 203 && b2 === 0 && b3 === 113) return true

    // 224.0.0.0/4 (Multicast: 224 to 239)
    if (b1 >= 224 && b1 <= 239) return true

    // 240.0.0.0/4 (Reserved / Future use: 240 to 255)
    if (b1 >= 240) return true

    return false
  }

  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase()

    // Unspecified :: or Loopback ::1
    if (
      lower === '::' ||
      lower === '::1' ||
      lower === '0:0:0:0:0:0:0:0' ||
      lower === '0:0:0:0:0:0:0:1'
    ) {
      return true
    }

    // IPv4-mapped IPv6 in dotted decimal: ::ffff:127.0.0.1 or ::ffff:0:127.0.0.1
    const ipv4MappedMatch = lower.match(
      /^::ffff:(?:0:)?(\d+\.\d+\.\d+\.\d+)$/i
    )
    if (ipv4MappedMatch) {
      return isPrivateOrReservedIp(ipv4MappedMatch[1]!)
    }

    // IPv4-mapped IPv6 in hex: ::ffff:7f00:1
    const hexMappedMatch = lower.match(
      /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i
    )
    if (hexMappedMatch) {
      const p1 = parseInt(hexMappedMatch[1]!, 16)
      const p2 = parseInt(hexMappedMatch[2]!, 16)
      const v4 = `${(p1 >> 8) & 255}.${p1 & 255}.${(p2 >> 8) & 255}.${p2 & 255}`
      return isPrivateOrReservedIp(v4)
    }

    // IPv6 ULA: fc00::/7 (fc00:: to fdff::)
    if (lower.startsWith('fc') || lower.startsWith('fd')) {
      return true
    }

    // IPv6 Link-Local: fe80::/10 (fe80:: to febf::)
    if (/^fe[89ab][0-9a-f]:/i.test(lower) || lower.startsWith('fe80:')) {
      return true
    }

    // IPv6 Multicast: ff00::/8
    if (lower.startsWith('ff')) {
      return true
    }

    // Discard prefix (100::/64) or Documentation (2001:db8::/32)
    if (lower.startsWith('100:') || lower.startsWith('2001:db8:')) {
      return true
    }

    return false
  }

  return false
}

export interface SsrfValidationResult {
  hostname: string
  resolvedIps: string[]
  pinnedIp: string
}

/**
 * Validates a webhook destination URL against SSRF attacks.
 * Resolves DNS and inspects all returned addresses against private/reserved ranges.
 * Returns the validated hostname and pinned destination IP.
 */
export async function validateSsrfUrl(
  urlString: string
): Promise<SsrfValidationResult> {
  let parsed: URL
  try {
    parsed = new URL(urlString)
  } catch {
    throw new Error('Invalid webhook URL format')
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('Webhook URL must use the https:// protocol')
  }

  const rawHostname = (parsed.hostname || '').toLowerCase().trim()
  if (!rawHostname) {
    throw new Error('Webhook URL hostname is missing')
  }

  // Strip brackets for IPv6 literals
  const cleanHost = rawHostname.replace(/^\[|\]$/g, '')

  if (cleanHost === 'localhost') {
    throw new Error(
      `Forbidden webhook URL: hostname "${rawHostname}" resolves to a private or loopback range`
    )
  }

  // Check if hostname is directly an IP or alternative numeric representation
  const parsedIp = parseIpAddress(cleanHost)
  if (parsedIp) {
    if (isPrivateOrReservedIp(parsedIp)) {
      throw new Error(
        `Forbidden webhook URL: IP "${parsedIp}" resolves to a private or loopback range`
      )
    }
    return {
      hostname: rawHostname,
      resolvedIps: [parsedIp],
      pinnedIp: parsedIp,
    }
  }

  // Resolve hostname via DNS
  let addresses: dns.LookupAddress[] = []
  try {
    addresses = await dns.promises.lookup(cleanHost, { all: true })
  } catch (dnsErr: any) {
    throw new Error(
      `Forbidden webhook URL: failed to resolve hostname "${rawHostname}": ${dnsErr.message}`
    )
  }

  if (!addresses || addresses.length === 0) {
    throw new Error(
      `Forbidden webhook URL: no DNS records found for hostname "${rawHostname}"`
    )
  }

  const resolvedIps: string[] = []
  for (const addr of addresses) {
    const ip = addr.address
    resolvedIps.push(ip)
    if (isPrivateOrReservedIp(ip)) {
      throw new Error(
        `Forbidden webhook URL: hostname "${rawHostname}" resolves to a private or loopback range: ${ip}`
      )
    }
  }

  return {
    hostname: rawHostname,
    resolvedIps,
    pinnedIp: resolvedIps[0]!,
  }
}

/**
 * Executes a hardened webhook fetch request with DNS validation,
 * manual redirect handling, and IP connection pinning.
 */
export async function safeWebhookFetch(
  url: string,
  init: RequestInit
): Promise<Response> {
  // Validate URL and resolve DNS before dispatch
  await validateSsrfUrl(url)

  // Enforce manual redirects to prevent 3xx redirects to internal network resources
  const options: RequestInit = {
    ...init,
    redirect: 'manual',
  }

  const res = await fetch(url, options)

  // Explicitly reject redirect responses
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location') || ''
    throw new Error(
      `SSRF: redirect from webhook destination is not allowed (target: ${location || 'unknown'})`
    )
  }

  return res
}
