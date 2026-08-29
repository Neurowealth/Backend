/** Best-effort device type from User-Agent (#376). Not a security control. */
export type DeviceType = 'web' | 'ios' | 'android' | 'cli' | 'unknown'

export function parseDeviceType(
  userAgent: string | null | undefined
): DeviceType {
  if (!userAgent) return 'unknown'
  const ua = userAgent.toLowerCase()

  if (/iphone|ipad|ipod/.test(ua)) return 'ios'
  if (/android/.test(ua)) return 'android'
  if (/curl|wget|httpie|python-requests|go-http|axios\/|node-fetch/.test(ua))
    return 'cli'
  if (/mozilla|chrome|safari|firefox|edge|opera/.test(ua)) return 'web'

  return 'unknown'
}
