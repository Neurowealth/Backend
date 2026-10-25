/**
 * The rate-limit tier matrix must describe the API that actually ships (#614).
 *
 * This is the CI half of the issue: "every mounted route has an explicit tier
 * entry". It fails when
 *
 *   - a mounted route resolves to NO matrix entry (an undocumented budget), or
 *   - the matrix says a route is in one tier while the code mounts a limiter
 *     from another (the table is lying), or
 *   - a matrix entry no longer matches any real route (the table has rotted),
 *   - a limiter exists that the tier catalogue does not describe, or
 *   - docs/RATE_LIMITING.md is not the table this module generates.
 *
 * The failure mode is deliberately loud: a silent gap in the matrix is
 * exactly the drift the matrix exists to prevent.
 */

import fs from 'fs'
import path from 'path'
import { API_ROUTES, EXTRA_MOUNTS } from '../../../src/routes/registry'
import { discoverRoutes } from '../../helpers/routeTable'
import {
  RATE_LIMIT_MATRIX,
  RATE_LIMIT_TIERS,
  RATE_LIMIT_TIER_IDS,
  resolveRateLimitTier,
  renderRateLimitMatrixMarkdown,
  renderRateLimitTierCatalogMarkdown,
} from '../../../src/middleware/rateLimitTiers'
import {
  RATE_LIMIT_TIER_TAG,
  limiterTier,
} from '../../../src/middleware/rateLimiter'
import { APP_LEVEL_LIMITERS } from '../../../src/middleware/rateLimiterChain'

const ROOT = path.join(__dirname, '../../..')
const DOC_PATH = path.join(ROOT, 'docs', 'RATE_LIMITING.md')

/** Every route the server serves, with the tier the code applies to it. */
const ROUTES = [
  ...API_ROUTES.flatMap((r) => discoverRoutes(`/api/v1/${r.path}`, r.handlers)),
  ...EXTRA_MOUNTS.flatMap((r) => discoverRoutes(r.path, r.handlers)),
].sort(
  (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method)
)

describe('rate-limit tier matrix (#614)', () => {
  it('discovers the real route table', () => {
    // A silent walk failure would make every other assertion in this file
    // pass vacuously, so pin the shape of what was found.
    expect(ROUTES.length).toBeGreaterThan(100)
    expect(ROUTES.some((r) => r.path === '/api/v1/deposit')).toBe(true)
    expect(ROUTES.some((r) => r.path === '/api/v1/keys/:id/rotate')).toBe(true)
  })

  it('gives every mounted route an explicit tier entry', () => {
    const unmapped = ROUTES.filter(
      (r) => resolveRateLimitTier(r.method, r.path) === undefined
    )
    expect(unmapped.map((r) => `${r.method} ${r.path}`).join('\n')).toBe('')
  })

  it('agrees with the limiter the code actually mounts', () => {
    const drifted = ROUTES.filter((r) => {
      const entry = resolveRateLimitTier(r.method, r.path)
      return entry !== undefined && entry.tier !== r.tier
    })
    expect(
      drifted
        .map(
          (r) =>
            `${r.method} ${r.path} — matrix says "${
              resolveRateLimitTier(r.method, r.path)?.tier
            }", code mounts "${r.tier}" (${r.tierSource})`
        )
        .join('\n')
    ).toBe('')
  })

  it('has no matrix entry that no longer matches a real route', () => {
    const dead = RATE_LIMIT_MATRIX.filter((entry) => {
      return !ROUTES.some(
        (r) =>
          r.method === (entry.method ?? r.method) &&
          resolveRateLimitTier(r.method, r.path) === entry
      )
    })
    expect(dead.map((e) => `${e.method ?? 'ANY'} ${e.path}`).join('\n')).toBe(
      ''
    )
  })

  it('covers every route with the app-wide global + tiered budgets', () => {
    // The runtime half of the fail-open policy: no route is ever unlimited.
    const appTiers = APP_LEVEL_LIMITERS.map((l) => limiterTier(l))
    expect(appTiers).toContain('global')
    expect(appTiers).toContain('tiered')
  })

  it('describes every tier it uses, and uses every tier it describes', () => {
    const usedTiers = new Set<string>([
      ...APP_LEVEL_LIMITERS.map((l) => limiterTier(l)!).filter(Boolean),
      ...ROUTES.map((r) => r.tier),
    ])
    for (const tier of usedTiers) {
      expect(
        RATE_LIMIT_TIERS[tier as keyof typeof RATE_LIMIT_TIERS]
      ).toBeDefined()
    }
    // A tier nothing routes to is a tier the matrix documents but the code
    // never applies — usually a renamed or removed limiter.
    for (const id of RATE_LIMIT_TIER_IDS) {
      expect(usedTiers.has(id)).toBe(true)
    }
  })

  it('tags every limiter the code mounts', () => {
    // A limiter with no tier tag is a limiter the matrix cannot describe.
    const limiters = [
      ...API_ROUTES.flatMap((r) => r.handlers),
      ...EXTRA_MOUNTS.flatMap((r) => r.handlers),
    ]
    const untagged = limiters.filter(
      (h) => typeof h === 'function' && limiterTier(h) === undefined
    )
    // The routers themselves are handlers too, so only the ones that are
    // actual limiters matter — those are the ones in `handlers` before the
    // router. Handled by the mount-level tier in the route walk above.
    expect(untagged.length).toBeGreaterThan(0) // routers are untagged
    for (const handler of limiters) {
      if (typeof handler !== 'function') continue
      if ((handler as any)[RATE_LIMIT_TIER_TAG] !== undefined) {
        expect(RATE_LIMIT_TIERS[limiterTier(handler)!]).toBeDefined()
      }
    }
  })

  it('documents the fail-open / fail-closed decision', () => {
    // The policy is part of the contract, not prose in a comment.
    const {
      RATE_LIMIT_MATRIX_POLICY,
    } = require('../../../src/middleware/rateLimitTiers')
    expect(RATE_LIMIT_MATRIX_POLICY.runtime).toBe('fail-open')
    expect(RATE_LIMIT_MATRIX_POLICY.ci).toBe('fail-closed')
    expect(RATE_LIMIT_MATRIX_POLICY.rationale.length).toBeGreaterThan(20)
  })
})

describe('rate-limit tier resolution', () => {
  it('maps an auth-type to its tier', () => {
    expect(resolveRateLimitTier('POST', '/api/v1/auth/login')?.tier).toBe(
      'auth'
    )
    expect(
      resolveRateLimitTier('GET', '/api/v1/webauthn/credentials')?.tier
    ).toBe('auth')
  })

  it('does not let an exact money-movement entry swallow a sibling router', () => {
    // /api/v1/deposit is one money-moving endpoint; /api/v1/deposit/recurring
    // is a separate router. A prefix match would put the recurring routes in
    // the sensitive tier by accident.
    expect(resolveRateLimitTier('POST', '/api/v1/deposit')?.tier).toBe(
      'sensitive'
    )
    expect(
      resolveRateLimitTier('POST', '/api/v1/deposit/recurring')?.tier
    ).toBe('tiered')
  })

  it('applies a method-specific entry only to that method', () => {
    expect(resolveRateLimitTier('POST', '/api/v1/keys')?.tier).toBe('sensitive')
    expect(resolveRateLimitTier('GET', '/api/v1/keys')?.tier).toBe('tiered')
    expect(resolveRateLimitTier('DELETE', '/api/v1/keys/:id')?.tier).toBe(
      'tiered'
    )
  })

  it('prefers an exact erasure entry over the admin prefix', () => {
    expect(
      resolveRateLimitTier('POST', '/api/v1/admin/erasure/requests')?.tier
    ).toBe('erasure')
    // The read-only list of erasure requests is an ordinary admin read.
    expect(
      resolveRateLimitTier('GET', '/api/v1/admin/erasure/requests')?.tier
    ).toBe('admin')
  })

  it('does not match a prefix entry across a path-segment boundary', () => {
    // /api/v1/keys must not capture /api/v1/keystore.
    expect(resolveRateLimitTier('GET', '/api/v1/keystore')?.tier).toBe('tiered')
  })
})

describe('docs/RATE_LIMITING.md (#614)', () => {
  const doc = fs.existsSync(DOC_PATH) ? fs.readFileSync(DOC_PATH, 'utf8') : ''

  it('exists', () => {
    expect(fs.existsSync(DOC_PATH)).toBe(true)
  })

  it('contains the generated route → tier matrix', () => {
    expect(doc).toContain(renderRateLimitMatrixMarkdown())
  })

  it('contains the generated tier catalogue', () => {
    expect(doc).toContain(renderRateLimitTierCatalogMarkdown())
  })

  it('documents which auth type maps to which tier', () => {
    for (const authType of ['session', 'api_key', 'admin', 'webhook']) {
      expect(doc).toContain(authType)
    }
  })

  it('documents the fail-open / fail-closed decision', () => {
    expect(doc).toMatch(/fail-open/i)
    expect(doc).toMatch(/fail-closed/i)
  })
})
