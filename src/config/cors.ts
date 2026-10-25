/**
 * CORS origin policy (#471).
 *
 * One place that decides whether an `Origin` header is allowed, independent of
 * Express and of the `cors` package, so the policy can be unit-tested directly
 * and so startup validation and the request-time check cannot disagree.
 *
 * Design rules:
 *
 *  1. **Staging is not development.** A staging deployment holds production-shaped
 *     data and real credentials. It enforces the allowlist exactly like
 *     production. Only `development` and `test` allow arbitrary origins.
 *
 *  2. **Wildcards are a development affordance.** `*` in production or staging is
 *     a misconfiguration and fails at startup, not at the first request. Because
 *     `credentials: true` is always on, a `*` allowlist would let any website
 *     read authenticated responses.
 *
 *  3. **Subdomain wildcards are opt-in and explicit.** `https://*.example.com`
 *     matches any single-label subdomain of the named host. It never matches the
 *     apex, and it never matches nested subdomains (`a.b.example.com`) — a
 *     wildcard that reaches arbitrary depth hands an attacker a domain to host
 *     under a name you do not control.
 *
 *  4. **Origins are normalised before comparison.** Browsers send
 *     `scheme://host[:port]` with no trailing slash, but configuration is written
 *     by humans, who add trailing slashes, uppercase hosts, and the default
 *     `https`/`http` port. All three are folded to the same canonical form so an
 *     allowlist entry that "looks wrong" still matches, and so `https://app.io`
 *     cannot be tricked into matching `https://app.io:443`.
 *
 *  5. **No origin header is not an origin.** Non-browser clients (curl, k8s
 *     probes, server-to-server) send none. They are governed by the auth and
 *     rate-limit layers, not by CORS, so they are allowed through — except in
 *     production, where a missing `Origin` on an unauthenticated write is a
 *     signal worth refusing. The strictness is configurable for operators who
 *     have browser clients that omit it.
 */

/** Environments that enforce the allowlist exactly as production does. */
const STRICT_ENVIRONMENTS = new Set(['production', 'staging'])

/** Environments where an arbitrary origin is acceptable. */
const PERMISSIVE_ENVIRONMENTS = new Set(['development', 'test'])

export type CorsEnvironment = 'development' | 'staging' | 'production' | 'test'

/** A wildcard allowlist entry: `https://*.example.com:8443`. */
export interface SubdomainPattern {
  /** Lowercased scheme the request origin must use. */
  protocol: string
  /** Lowercased apex host, with the wildcard label removed. */
  host: string
  /** Port to require, or null when the pattern named no port / the default. */
  port: number | null
  /** The pattern as configured, for error messages. */
  source: string
}

export interface CorsOriginPolicy {
  /** True when the environment permits any origin (development/test only). */
  allowAnyOrigin: boolean
  /** Canonical exact-match origins. */
  origins: string[]
  /** Canonical subdomain wildcard patterns. */
  patterns: SubdomainPattern[]
  /**
   * True when the configuration asked for `*` and the environment refuses it.
   * Startup validation turns this into a hard failure; request handling treats
   * it as "nothing is allowed" so a server that somehow booted misconfigured
   * fails closed.
   */
  wildcardRejected: boolean
  /** Entries that could not be parsed, kept for error messages. */
  invalidEntries: string[]
  /** True when the allowlist is enforced (production/staging). */
  strict: boolean
  /** True when a request with no `Origin` header should be refused. */
  requireOrigin: boolean
}

const DEFAULT_PORTS: Record<string, number> = { 'http:': 80, 'https:': 443 }

/**
 * Canonicalise a configured or request-supplied origin.
 * Returns null when the value is not a usable absolute origin.
 */
export function normalizeOrigin(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }

  // `null` origin (sandboxed iframe, privacy-redacted) and anything that is not
  // an http(s) origin must never be allowlisted — they are not a web origin we
  // can reason about.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (!url.hostname) return null
  // A path/query/fragment in a configured origin is a configuration mistake:
  // browsers never send one, so the entry could never match. Reject rather than
  // silently truncate, so the operator sees it.
  if (url.pathname && url.pathname !== '/') return null
  if (url.search || url.hash) return null
  if (url.username || url.password) return null

  const protocol = url.protocol
  const hostname = url.hostname.toLowerCase()
  // WHATWG URL already drops a port that equals the scheme default, so a
  // non-empty `url.port` here is always a port the origin really carries.
  const port = url.port ? Number(url.port) : null

  return port ? `${protocol}//${hostname}:${port}` : `${protocol}//${hostname}`
}

/**
 * Parse a `scheme://*.host[:port]` pattern. Returns null if the value is not a
 * well-formed single-label subdomain wildcard.
 */
export function parseSubdomainPattern(value: string): SubdomainPattern | null {
  const trimmed = value.trim()
  if (!trimmed.includes('://*.')) return null

  const authority = trimmed.slice(trimmed.indexOf('://') + 3)
  if (authority.includes('/')) return null

  // Exactly one `*`, and it must be the whole leftmost label.
  const starCount = (authority.match(/\*/g) ?? []).length
  if (starCount !== 1) return null
  if (!authority.startsWith('*.')) return null

  // Parse a concrete host so the standard URL parser validates the rest.
  let url: URL
  try {
    url = new URL(trimmed.replace('://*.', '://wildcard-placeholder.'))
  } catch {
    return null
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null

  const host = url.hostname.toLowerCase().replace(/^wildcard-placeholder\./, '')
  if (!host || host.includes('*')) return null
  // null means "the pattern named no port", which the matcher resolves to the
  // scheme default. A pattern for https://*.example.com must not match :8443.
  const port = url.port ? Number(url.port) : null

  return { protocol: url.protocol, host, port, source: trimmed }
}

/** Split a comma-separated origin list into trimmed, non-empty entries. */
export function splitOriginList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

export interface BuildOriginPolicyInput {
  /** Raw comma-separated value from `CORS_ORIGINS` / `ALLOWED_ORIGINS`. */
  raw: string | undefined
  /** Active `NODE_ENV`. */
  environment: string
  /**
   * Refuse requests that carry no `Origin` header. Defaults to true in
   * production. Staging defaults to false so CLI and probe traffic works while
   * the environment is being stood up.
   */
  requireOrigin?: boolean
}

export function buildOriginPolicy(
  input: BuildOriginPolicyInput
): CorsOriginPolicy {
  const environment = input.environment as CorsEnvironment
  const strict = STRICT_ENVIRONMENTS.has(environment)
  const permissive = PERMISSIVE_ENVIRONMENTS.has(environment)

  const policy: CorsOriginPolicy = {
    allowAnyOrigin: false,
    origins: [],
    patterns: [],
    wildcardRejected: false,
    invalidEntries: [],
    strict,
    // Production refuses a request with no Origin header. Staging does not, so
    // CLI tooling and probes keep working while the environment is stood up;
    // operators can opt in via CORS_REQUIRE_ORIGIN.
    requireOrigin: input.requireOrigin ?? environment === 'production',
  }

  const entries = splitOriginList(input.raw)

  // No allowlist configured. In a permissive environment that means "any
  // origin", which is the local-dev default. In a strict environment it is a
  // misconfiguration and nothing is allowed.
  if (entries.length === 0) {
    policy.allowAnyOrigin = permissive
    return policy
  }

  // A bare `*` is the wildcard. In production and staging it is refused
  // outright: with `credentials: true` it would let any website read
  // authenticated responses.
  if (entries.length === 1 && entries[0] === '*') {
    if (permissive) {
      policy.allowAnyOrigin = true
    } else {
      policy.wildcardRejected = true
    }
    return policy
  }

  for (const entry of entries) {
    if (entry === '*') {
      // A `*` mixed into an explicit list is almost always an accident, and it
      // silently widens the policy to everything. Refuse it.
      policy.wildcardRejected = true
      policy.invalidEntries.push(entry)
      continue
    }

    const pattern = parseSubdomainPattern(entry)
    if (pattern) {
      policy.patterns.push(pattern)
      continue
    }

    const origin = normalizeOrigin(entry)
    if (origin) {
      if (!policy.origins.includes(origin)) policy.origins.push(origin)
    } else {
      policy.invalidEntries.push(entry)
    }
  }

  return policy
}

export type OriginDecision =
  /** The environment permits any origin. */
  | { allowed: true; reason: 'any-origin-allowed' }
  /** The origin is on the allowlist. */
  | { allowed: true; reason: 'allowlisted'; origin: string }
  /** The origin matched a configured subdomain wildcard. */
  | {
      allowed: true
      reason: 'subdomain-match'
      origin: string
      pattern: string
    }
  /** The origin is not allowed, and why. */
  | {
      allowed: false
      reason:
        | 'not-allowlisted'
        | 'no-origin-header'
        | 'empty-allowlist'
        | 'wildcard-misconfiguration'
        | 'invalid-configuration'
    }
  /** The request supplied no Origin header and the environment requires one. */
  | { allowed: false; reason: 'no-origin-header' }

function subdomainMatches(pattern: SubdomainPattern, origin: URL): boolean {
  if (origin.protocol !== pattern.protocol) return false
  if (origin.hostname.toLowerCase() === pattern.host) return false // apex is explicit
  if (!origin.hostname.toLowerCase().endsWith(`.${pattern.host}`)) return false

  // Single label only: `a.b.example.com` must not match `*.example.com`.
  const prefix = origin.hostname
    .toLowerCase()
    .slice(0, origin.hostname.length - pattern.host.length - 1)
  if (prefix.length === 0 || prefix.includes('.')) return false

  const port = origin.port
    ? Number(origin.port)
    : (DEFAULT_PORTS[origin.protocol] ?? null)
  const required = pattern.port ?? DEFAULT_PORTS[pattern.protocol] ?? null
  return port === required
}

/**
 * Decide whether a request origin is allowed under `policy`.
 *
 * @param policy the policy built by {@link buildOriginPolicy}
 * @param requestOrigin the raw `Origin` header value, or undefined when absent
 */
export function evaluateOrigin(
  policy: CorsOriginPolicy,
  requestOrigin: string | undefined
): OriginDecision {
  if (!requestOrigin) {
    if (policy.requireOrigin)
      return { allowed: false, reason: 'no-origin-header' }
    return { allowed: true, reason: 'any-origin-allowed' }
  }

  if (policy.allowAnyOrigin)
    return { allowed: true, reason: 'any-origin-allowed' }

  if (policy.wildcardRejected) {
    return { allowed: false, reason: 'wildcard-misconfiguration' }
  }

  if (policy.origins.length === 0 && policy.patterns.length === 0) {
    if (!policy.strict) return { allowed: true, reason: 'any-origin-allowed' }
    // Entries were configured but none of them parsed — a typo in the
    // allowlist, which must not degrade into "allow nothing silently".
    return policy.invalidEntries.length > 0
      ? { allowed: false, reason: 'invalid-configuration' }
      : { allowed: false, reason: 'empty-allowlist' }
  }

  const normalized = normalizeOrigin(requestOrigin)
  if (!normalized) return { allowed: false, reason: 'not-allowlisted' }

  if (policy.origins.includes(normalized)) {
    return { allowed: true, reason: 'allowlisted', origin: normalized }
  }

  let parsed: URL
  try {
    parsed = new URL(requestOrigin)
  } catch {
    return { allowed: false, reason: 'not-allowlisted' }
  }

  for (const pattern of policy.patterns) {
    if (subdomainMatches(pattern, parsed)) {
      return {
        allowed: true,
        reason: 'subdomain-match',
        origin: normalized,
        pattern: pattern.source,
      }
    }
  }

  return { allowed: false, reason: 'not-allowlisted' }
}

const REASON_MESSAGES: Record<
  Extract<OriginDecision, { allowed: false }>['reason'],
  string
> = {
  'no-origin-header': 'CORS: missing Origin header',
  'empty-allowlist': 'CORS: server misconfiguration — no origins allowed',
  'wildcard-misconfiguration':
    'CORS: server misconfiguration — wildcard origins are not permitted outside development',
  'invalid-configuration':
    'CORS: server misconfiguration — no valid origins configured',
  'not-allowlisted': 'CORS: origin is not allowed',
}

/** Human-readable explanation for a rejection, used in the 403 body. */
export function describeRejection(
  decision: Extract<OriginDecision, { allowed: false }>
): string {
  return REASON_MESSAGES[decision.reason]
}
