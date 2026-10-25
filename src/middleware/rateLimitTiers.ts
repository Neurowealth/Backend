/**
 * The rate-limit tier catalog and the route → tier matrix (#614).
 *
 * Before this module existed, the limits lived only in code: every limiter was
 * constructed inline in src/middleware/rateLimiter.ts and mounted by hand in
 * src/index.ts or inside a route file. A contributor asking "what is the budget
 * on POST /api/v1/deposit, and does it apply to a session or an API key?" had
 * no answer that was not a archaeology exercise across three files — and no
 * check that the answer stayed true.
 *
 * This module is the single, machine-readable source of truth:
 *
 *   1. RATE_LIMIT_TIERS      — every tier, its window/burst, the principal it
 *                              charges, the auth types that land in it, and the
 *                              env vars that move it.
 *   2. RATE_LIMIT_MATRIX     — the route → tier bindings.
 *
 * tests/unit/middleware/rateLimitTierMatrix.test.ts fails CI when the two
 * drift from the code: an unmapped route, a matrix entry that no longer
 * matches any real route, a limiter that is not in the catalog, or a route
 * whose attached limiter disagrees with the matrix.
 *
 * The matrix is expressed against the CANONICAL /api/v1/* paths. The legacy
 * unversioned /api/* aliases are mounted from the same route table and
 * therefore carry the same tier; see src/routes/registry.ts.
 */

import { config } from '../config/env'

// ── Tier identity ───────────────────────────────────────────────────────────

/**
 * The tier ids. These are also the `limiterType` strings that reach the
 * Prometheus metrics (src/utils/metrics.ts), so a tier id appearing in a
 * dashboard can be traced straight back to this file.
 */
export const RATE_LIMIT_TIER_IDS = [
  'global',
  'tiered',
  'auth',
  'admin',
  'erasure',
  'webhook',
  'sensitive',
  'optimizer',
  'simulate',
  'internal',
] as const

export type RateLimitTierId = (typeof RATE_LIMIT_TIER_IDS)[number]

/**
 * How a request is identified when its budget is spent.
 *
 *   ip        — one bucket per client address. Used where no identity has
 *               been proven yet (login attempts) or where the caller is
 *               anonymous by design (inbound webhooks).
 *   principal — one bucket per proven identity: a session's user id, an API
 *               key's key id, the admin credential, or the internal service
 *               token. Two keys behind one NAT get two budgets.
 */
export type RateLimitPrincipalKind = 'ip' | 'principal'

/**
 * The caller identities a tier is designed for. `webhook` is the inbound
 * provider callbacks (Twilio/Telegram/fiat) — authenticated by HMAC signature
 * rather than by a bearer token, so it is a tier of its own.
 */
export type RateLimitAuthType =
  'session' | 'api_key' | 'admin' | 'webhook' | 'internal' | 'anonymous'

export interface RateLimitTierDefinition {
  id: RateLimitTierId
  /** What this tier is for, and why it exists. */
  purpose: string
  /** What the budget is charged against. */
  principal: RateLimitPrincipalKind
  /** Which caller identities land in this tier. */
  authTypes: RateLimitAuthType[]
  /** Effective window in milliseconds. */
  windowMs: number
  /** Effective burst — requests allowed per window. */
  max: number
  /** The env vars that move this tier, so an operator can find them. */
  env: { windowMs: string; max: string }
  /**
   * What happens to a request that reaches a tier this catalogue does not
   * describe. Documented per tier because the answer is not the same
   * everywhere: a route with no matrix entry still gets the global + tiered
   * budgets (never unlimited), but the CI check treats the missing entry as
   * a failure — see RATE_LIMIT_MATRIX_POLICY below.
   */
  onUnknownCaller: 'anonymous-tier' | 'strict-tier'
}

// ── The catalogue ───────────────────────────────────────────────────────────

const { security } = config

/**
 * Every rate-limit tier, with its live values. The numbers come from
 * `config.security` so the catalogue can never drift from what the limiter
 * actually enforces — only the env var NAMES are spelled out here, as a
 * pointer for operators.
 */
export const RATE_LIMIT_TIERS: Record<
  RateLimitTierId,
  RateLimitTierDefinition
> = {
  global: {
    id: 'global',
    purpose:
      'Baseline budget for every route. Catches runaway clients and gives ' +
      'the more specific tiers something to sit on top of.',
    principal: 'principal',
    authTypes: ['session', 'api_key', 'admin', 'webhook', 'internal'],
    windowMs: security.rateLimit.windowMs,
    max: security.rateLimit.max,
    env: { windowMs: 'RATE_LIMIT_WINDOW_MS', max: 'RATE_LIMIT_MAX' },
    onUnknownCaller: 'strict-tier',
  },
  tiered: {
    id: 'tiered',
    purpose:
      'Identity tiering. Anonymous callers draw on a strict per-IP budget; ' +
      'callers that proved an identity draw on a generous per-principal one. ' +
      'An API key’s own allowance overrides this tier entirely.',
    principal: 'principal',
    authTypes: ['session', 'api_key', 'admin', 'internal'],
    windowMs: security.anonymousRateLimit.windowMs,
    max: security.anonymousRateLimit.max,
    env: {
      windowMs: 'ANONYMOUS_RATE_LIMIT_WINDOW_MS',
      max: 'ANONYMOUS_RATE_LIMIT_MAX',
    },
    onUnknownCaller: 'strict-tier',
  },
  auth: {
    id: 'auth',
    purpose:
      'Credential endpoints. Deliberately IP-keyed: credential stuffing ' +
      'happens before any identity is proven, so a per-user key would be ' +
      'meaningless here.',
    principal: 'ip',
    authTypes: ['anonymous', 'session'],
    windowMs: security.authRateLimit.windowMs,
    max: security.authRateLimit.max,
    env: { windowMs: 'AUTH_RATE_LIMIT_WINDOW_MS', max: 'AUTH_RATE_LIMIT_MAX' },
    onUnknownCaller: 'strict-tier',
  },
  admin: {
    id: 'admin',
    purpose:
      'The management API. Tightest of the general tiers — these routes ' +
      'move reserves, mint keys and settle referrals.',
    principal: 'principal',
    authTypes: ['admin', 'internal'],
    windowMs: security.adminRateLimit.windowMs,
    max: security.adminRateLimit.max,
    env: {
      windowMs: 'ADMIN_RATE_LIMIT_WINDOW_MS',
      max: 'ADMIN_RATE_LIMIT_MAX',
    },
    onUnknownCaller: 'strict-tier',
  },
  erasure: {
    id: 'erasure',
    purpose:
      'Right-to-erasure. Irreversible, so it is held far below the general ' +
      'admin budget — a bug that loops here would delete data repeatedly.',
    principal: 'principal',
    authTypes: ['admin', 'internal'],
    windowMs: 15 * 60 * 1000,
    max: 5,
    env: { windowMs: '(fixed)', max: '(fixed)' },
    onUnknownCaller: 'strict-tier',
  },
  webhook: {
    id: 'webhook',
    purpose:
      'Inbound provider callbacks. Unauthenticated at the transport layer — ' +
      'the HMAC signature is the credential — so the budget resists ' +
      'spoofed and replayed floods.',
    principal: 'ip',
    authTypes: ['webhook'],
    windowMs: security.webhookRateLimit.windowMs,
    max: security.webhookRateLimit.max,
    env: {
      windowMs: 'WEBHOOK_RATE_LIMIT_WINDOW_MS',
      max: 'WEBHOOK_RATE_LIMIT_MAX',
    },
    onUnknownCaller: 'strict-tier',
  },
  sensitive: {
    id: 'sensitive',
    purpose:
      'Money movement and credential changes. Applied per-endpoint IN ' +
      'ADDITION to the route’s normal budget, so a burst of withdrawals is ' +
      'stopped without throttling the balance reads the user needs to ' +
      'decide.',
    principal: 'principal',
    authTypes: ['session', 'api_key'],
    windowMs: security.sensitiveRateLimit.windowMs,
    max: security.sensitiveRateLimit.max,
    env: {
      windowMs: 'SENSITIVE_RATE_LIMIT_WINDOW_MS',
      max: 'SENSITIVE_RATE_LIMIT_MAX',
    },
    onUnknownCaller: 'strict-tier',
  },
  optimizer: {
    id: 'optimizer',
    purpose:
      'The CPU-bound allocation suggester. Pairs with the in-flight ' +
      'semaphore in src/utils/concurrency.ts: that bounds how many run at ' +
      'once, this bounds how often they start.',
    principal: 'principal',
    authTypes: ['session', 'api_key'],
    windowMs: security.optimizerRateLimit.windowMs,
    max: security.optimizerRateLimit.max,
    env: {
      windowMs: 'OPTIMIZER_RATE_LIMIT_WINDOW_MS',
      max: 'OPTIMIZER_RATE_LIMIT_MAX',
    },
    onUnknownCaller: 'strict-tier',
  },
  simulate: {
    id: 'simulate',
    purpose:
      'The CPU-bound historical replay. Tight enough that the replay cannot ' +
      'be used as a CPU-exhaustion vector; pairs with the short-TTL result ' +
      'cache so identical previews are served without recomputing.',
    principal: 'principal',
    authTypes: ['session', 'api_key'],
    windowMs: security.simulateRateLimit.windowMs,
    max: security.simulateRateLimit.max,
    env: {
      windowMs: 'SIMULATE_RATE_LIMIT_WINDOW_MS',
      max: 'SIMULATE_RATE_LIMIT_MAX',
    },
    onUnknownCaller: 'strict-tier',
  },
  internal: {
    id: 'internal',
    purpose:
      'Service-to-service calls (the agent loop). Higher throughput than ' +
      'the user-facing tiers, and IP-keyed because the internal token is a ' +
      'single shared credential.',
    principal: 'ip',
    authTypes: ['internal'],
    windowMs: security.internalRateLimit.windowMs,
    max: security.internalRateLimit.max,
    env: {
      windowMs: 'INTERNAL_RATE_LIMIT_WINDOW_MS',
      max: 'INTERNAL_RATE_LIMIT_MAX',
    },
    onUnknownCaller: 'strict-tier',
  },
}

/**
 * The authenticated tier of `tiered` — a larger budget for callers that have
 * proved an identity. Exposed separately because it is a real allowance with
 * its own env vars, not a variant of the anonymous one.
 */
export const AUTHENTICATED_TIER_LIMITS = {
  windowMs: security.authenticatedRateLimit.windowMs,
  max: security.authenticatedRateLimit.max,
  env: {
    windowMs: 'AUTHENTICATED_RATE_LIMIT_WINDOW_MS',
    max: 'AUTHENTICATED_RATE_LIMIT_MAX',
  },
} as const

// ── The route → tier matrix ─────────────────────────────────────────────────

export interface RateLimitMatrixEntry {
  /**
   * The canonical (versioned) path this entry covers, in Express's own route
   * syntax — `:id` for a parameter.
   */
  path: string
  /**
   * When true, the entry covers this path AND everything under it. When
   * false (the default) the path must match exactly.
   *
   * The distinction matters: `/api/v1/deposit` is a single money-moving
   * endpoint, while `/api/v1/deposit/recurring` is a separate router whose
   * routes are scheduled deposits. A prefix entry on `/api/v1/deposit` would
   * silently sweep the recurring router into the sensitive tier.
   */
  prefix?: boolean
  /** HTTP method, when the binding is method-specific. */
  method?: string
  /** The tier that applies. */
  tier: RateLimitTierId
  /** Why this route has this tier. */
  note: string
}

/**
 * The matrix.
 *
 * The resolver picks the most specific match: an exact entry beats a prefix
 * entry, a longer path beats a shorter one, and a method-specific entry
 * beats a path-only one. So the order here is for readability, not for
 * correctness.
 */
export const RATE_LIMIT_MATRIX: readonly RateLimitMatrixEntry[] = [
  // ── Credential endpoints (auth tier) ─────────────────────────────────────
  {
    path: '/api/v1/auth',
    prefix: true,
    tier: 'auth',
    note: 'Login, refresh, logout — credential stuffing surface.',
  },
  {
    path: '/api/v1/auth/webauthn',
    prefix: true,
    tier: 'auth',
    note: 'WebAuthn ceremonies — same credential surface as password auth.',
  },
  {
    path: '/api/v1/webauthn',
    prefix: true,
    tier: 'auth',
    note: 'Top-level WebAuthn alias, same ceremony budget.',
  },

  // ── Inbound webhooks (webhook tier) ─────────────────────────────────────
  {
    path: '/api/v1/whatsapp',
    prefix: true,
    tier: 'webhook',
    note: 'Inbound WhatsApp provider callbacks, HMAC-signed.',
  },
  {
    path: '/api/v1/telegram',
    prefix: true,
    tier: 'webhook',
    note: 'Inbound Telegram provider callbacks, HMAC-signed.',
  },

  // ── The management API (admin tier) ─────────────────────────────────────
  {
    path: '/api/v1/admin',
    prefix: true,
    tier: 'admin',
    note: 'Management API — reserves, key minting, referral settlement.',
  },
  {
    path: '/api/v1/admin/support/tickets',
    prefix: true,
    tier: 'admin',
    note: 'Admin view of support tickets.',
  },
  {
    path: '/api/v1/admin/notifications/dlq',
    prefix: true,
    tier: 'admin',
    note: 'Dead-letter queue inspection and replay.',
  },

  // ── Erasure (erasure tier) ──────────────────────────────────────────────
  // Irreversible, so these are held far below the general admin budget.
  {
    path: '/api/v1/admin/erasure/requests',
    method: 'POST',
    tier: 'erasure',
    note: 'Creating an erasure request is a destructive operation.',
  },
  {
    path: '/api/v1/admin/erasure/requests/:id/approve',
    method: 'POST',
    tier: 'erasure',
    note: 'Approving an erasure request authorises data deletion.',
  },
  {
    path: '/api/v1/admin/erasure/requests/:id/reject',
    method: 'POST',
    tier: 'erasure',
    note: 'Rejecting an erasure request is part of the erasure workflow.',
  },
  {
    path: '/api/v1/admin/erasure/requests/:id/execute',
    method: 'POST',
    tier: 'erasure',
    note: 'Executing an erasure request deletes data — the sharpest edge.',
  },
  {
    path: '/api/v1/admin/erasure/preview/:userId',
    method: 'GET',
    tier: 'erasure',
    note: 'Previewing an erasure walks the same deletion path as the execute.',
  },

  // ── Money movement and credential changes (sensitive tier) ──────────────
  {
    path: '/api/v1/deposit',
    method: 'POST',
    tier: 'sensitive',
    note: 'Deposits move money — irreversible once submitted.',
  },
  {
    path: '/api/v1/withdraw',
    method: 'POST',
    tier: 'sensitive',
    note: 'Withdrawals move money — irreversible once submitted.',
  },
  {
    path: '/api/v1/loans',
    method: 'POST',
    tier: 'sensitive',
    note: 'Loan origination moves money.',
  },
  {
    path: '/api/v1/loans/:loanId/repay',
    method: 'POST',
    tier: 'sensitive',
    note: 'Loan repayment moves money.',
  },
  {
    path: '/api/v1/keys',
    method: 'POST',
    tier: 'sensitive',
    note: 'Minting an API key is a takeover vector — credential change.',
  },
  {
    path: '/api/v1/keys/:id/rotate',
    method: 'POST',
    tier: 'sensitive',
    note: 'Rotating a key is a credential change.',
  },
  {
    path: '/api/v1/support/tickets',
    method: 'POST',
    tier: 'sensitive',
    note: 'Opening a ticket is a state change on a customer-visible record.',
  },
  {
    path: '/api/v1/accounting',
    prefix: true,
    tier: 'tiered',
    note:
      'Accounting export is a user-scoped read gated by transactions:read; ' +
      'the reconciliation gate runs before any bytes are sent.',
  },

  // ── Compute-bound endpoints (optimizer / simulate tiers) ────────────────
  {
    path: '/api/v1/portfolio/:userId/suggest-allocation',
    method: 'POST',
    tier: 'optimizer',
    note: 'CPU-bound allocation solver — the classic exhaustion vector.',
  },
  {
    path: '/api/v1/strategies/simulate',
    method: 'POST',
    tier: 'simulate',
    note: 'CPU-bound historical replay.',
  },

  // ── Service-to-service (internal tier) ──────────────────────────────────
  {
    path: '/api/v1/agent/decisions',
    prefix: true,
    tier: 'tiered',
    note:
      'Agent decision history is a user-facing read (session auth), not a ' +
      'service-to-service call — only the agent status endpoints are.',
  },
  {
    path: '/api/v1/agent',
    prefix: true,
    tier: 'internal',
    note: 'Agent loop endpoints — service-to-service, guarded by the internal token.',
  },

  // ── Everything else: the global + tiered baseline ──────────────────────
  {
    path: '/api/v1',
    prefix: true,
    tier: 'tiered',
    note:
      'Default for every remaining versioned API route: the global budget ' +
      'plus the identity tier (strict per-IP when anonymous, generous ' +
      'per-principal once authenticated).',
  },
  {
    path: '/api/webhooks',
    prefix: true,
    tier: 'tiered',
    note: 'Pre-version webhook management surface; same baseline as /api/v1.',
  },
  {
    path: '/api/analytics',
    prefix: true,
    tier: 'tiered',
    note: 'Pre-version analytics alias; same baseline as /api/v1.',
  },
  {
    path: '/api/stellar',
    prefix: true,
    tier: 'tiered',
    note: 'Pre-version Stellar alias; same baseline as /api/v1.',
  },
  {
    path: '/health',
    prefix: true,
    tier: 'tiered',
    note:
      'Liveness and readiness probes. The GLOBAL limiter skips these so ' +
      'k8s probes never consume the budget; the tiered limiter still applies.',
  },
  {
    path: '/metrics',
    prefix: true,
    tier: 'tiered',
    note: 'Prometheus scrape endpoint, guarded by the internal auth guard.',
  },
] as const

/**
 * The fail-open vs fail-closed decision, stated once so it can be cited.
 *
 * RUNTIME — fail-OPEN in the sense that no route is ever unlimited: the
 * global and tiered limiters are mounted app-wide (src/index.ts), so an
 * unmapped route still gets a budget. It is not "fail-open" in the sense of
 * letting a request through unchecked.
 *
 * CI — fail-CLOSED: a route with no matrix entry, or a matrix entry that no
 * longer matches a real route, fails the build. The runtime behaviour is a
 * safety net; the matrix is the contract, and the contract is enforced.
 */
export const RATE_LIMIT_MATRIX_POLICY = {
  runtime: 'fail-open' as const,
  ci: 'fail-closed' as const,
  rationale:
    'Every route inherits the global + tiered budgets at runtime, so an ' +
    'unmapped route is never unlimited. CI is strict instead, because a ' +
    'silent gap in the matrix is exactly the kind of drift this catalogue ' +
    'exists to prevent.',
}

// ── Resolution ─────────────────────────────────────────────────────────────

/** Normalise a path for matching: strip the query, the version prefix and a trailing slash. */
function normalisePath(path: string): string {
  let p = path.split('?')[0]
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1)
  return p || '/'
}

/**
 * Resolve the tier for a request.
 *
 * Specificity, strongest first:
 *   1. an exact path match beats a prefix match
 *   2. a longer path beats a shorter one
 *   3. at equal path, a method-specific entry beats a path-only one
 *
 * Returns undefined when nothing matches — the caller (the CI check) treats
 * that as a failure.
 */
export function resolveRateLimitTier(
  method: string,
  path: string
): RateLimitMatrixEntry | undefined {
  const target = normalisePath(path)
  const verb = method.toUpperCase()

  let best: RateLimitMatrixEntry | undefined
  let bestScore = -1

  for (const entry of RATE_LIMIT_MATRIX) {
    const entryPath = normalisePath(entry.path)

    let pathMatches: boolean
    if (entry.prefix) {
      // A prefix entry covers the path itself and everything under it, but
      // only on a path-segment boundary: `/api/v1/keys` must not match
      // `/api/v1/keystore`.
      pathMatches =
        target === entryPath ||
        (entryPath !== '/' && target.startsWith(entryPath + '/'))
    } else {
      pathMatches = target === entryPath
    }
    if (!pathMatches) continue

    // A method-specific entry only applies to that method; a path-only entry
    // applies to every method.
    if (entry.method && entry.method.toUpperCase() !== verb) continue

    const score =
      entryPath.length * 100 + (entry.prefix ? 0 : 10) + (entry.method ? 1 : 0)
    if (score > bestScore) {
      best = entry
      bestScore = score
    }
  }

  return best
}

/** The tier for a request, or undefined when the route is not in the matrix. */
export function tierForRoute(
  method: string,
  path: string
): RateLimitTierId | undefined {
  return resolveRateLimitTier(method, path)?.tier
}

/**
 * Render the matrix as a Markdown table — the source of the table in
 * docs/RATE_LIMITING.md. Kept here (rather than hand-written in the doc) so
 * the two cannot drift: the doc is generated, the test asserts it is current.
 */
export function renderRateLimitMatrixMarkdown(): string {
  const header = '| Route | Method | Tier | Window | Burst | Why |'
  const divider = '| --- | --- | --- | --- | --- | --- |'
  const rows = RATE_LIMIT_MATRIX.map((entry) => {
    const tier = RATE_LIMIT_TIERS[entry.tier]
    const window =
      entry.tier === 'tiered'
        ? `${tier.windowMs}ms / ${AUTHENTICATED_TIER_LIMITS.max} authenticated`
        : `${tier.windowMs}ms`
    return `| \`${entry.path}\` | ${entry.method ?? 'ANY'} | \`${entry.tier}\` | ${window} | ${tier.max} | ${entry.note} |`
  })
  return [header, divider, ...rows].join('\n')
}

/** Render the tier catalogue as a Markdown table. */
export function renderRateLimitTierCatalogMarkdown(): string {
  const header = '| Tier | Window | Burst | Principal | Auth types | Purpose |'
  const divider = '| --- | --- | --- | --- | --- | --- |'
  const rows = RATE_LIMIT_TIER_IDS.map((id) => {
    const tier = RATE_LIMIT_TIERS[id]
    return `| \`${id}\` | ${tier.windowMs}ms | ${tier.max} | ${tier.principal} | ${tier.authTypes.join(', ')} | ${tier.purpose} |`
  })
  return [header, divider, ...rows].join('\n')
}
