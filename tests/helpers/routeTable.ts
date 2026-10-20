/**
 * Route-table introspection for the tier-matrix CI check (#614).
 *
 * Express 4 has no public "list my routes" API, so the check walks the
 * router stack directly. This is the only place that knows how to do that,
 * so the walk stays in one file and every consumer sees the same route
 * shapes.
 *
 * The paths produced here are Express's own route syntax — `:id` for a
 * parameter — and they are the paths the tier matrix in
 * src/middleware/rateLimitTiers.ts is written against.
 */

import { type RequestHandler } from 'express'
import { limiterTier } from '../../src/middleware/rateLimiter'
import type { RateLimitTierId } from '../../src/middleware/rateLimitTiers'

export interface DiscoveredRoute {
  method: string
  /** The full path, e.g. `/api/v1/keys/:id/rotate`. */
  path: string
  /**
   * The tier the CODE applies to this route: the route's own limiter if it
   * has one, otherwise the mount-level limiter, otherwise the app-wide
   * baseline (`tiered`).
   */
  tier: RateLimitTierId
  /** Where the tier came from — useful when a test fails. */
  tierSource: 'route' | 'mount' | 'baseline'
}

/**
 * Turn an Express 4 path regexp back into a readable path.
 *
 * Only needed for `router.use(path, subRouter)` mounts, where Express does
 * not keep the original path string on the layer. Route layers expose
 * `layer.route.path` directly, so this is only the fallback.
 */
function pathFromRegexp(source: string): string {
  let s = source
  s = s.replace(/^\^/, '')
  s = s.replace(/\\\/\?\(\?=\\\/\|\$\)$/, '')
  s = s.replace(/\\\//g, '/')
  s = s.replace(/\(\?:[^)]*\)/g, ':p')
  s = s.replace(/\([^)]*\)/g, ':p')
  return s || '/'
}

/** Normalise a path for comparison: no trailing slash, except for the root. */
export function normaliseRoutePath(path: string): string {
  const p = path.split('?')[0]
  if (p.length > 1 && p.endsWith('/')) return p.slice(0, -1)
  return p || '/'
}

function walkStack(
  stack: any[],
  prefix: string,
  mountTier: RateLimitTierId | undefined,
  out: DiscoveredRoute[]
): void {
  for (const layer of stack) {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods || {})
      for (const method of methods) {
        let tier = mountTier
        let tierSource: DiscoveredRoute['tierSource'] = mountTier
          ? 'mount'
          : 'baseline'

        for (const handle of layer.route.stack || []) {
          const routeTier = limiterTier(handle.handle)
          if (routeTier) {
            tier = routeTier
            tierSource = 'route'
          }
        }

        out.push({
          method: method.toUpperCase(),
          path: normaliseRoutePath(prefix + (layer.route.path || '')),
          tier: tier ?? 'tiered',
          tierSource,
        })
      }
    } else if (layer.name === 'router' && layer.handle?.stack) {
      const nested = pathFromRegexp(layer.regexp.source)
      walkStack(
        layer.handle.stack,
        prefix + (nested === '/' ? '' : nested),
        mountTier,
        out
      )
    }
  }
}

/**
 * Walk a mounted router and return every route it serves, with the tier the
 * code applies to it.
 */
export function discoverRoutes(
  mountPath: string,
  handlers: RequestHandler[]
): DiscoveredRoute[] {
  let mountTier: RateLimitTierId | undefined
  for (const handler of handlers) {
    const tier = limiterTier(handler)
    if (tier) mountTier = tier
  }

  const router = handlers[handlers.length - 1] as unknown as {
    stack?: any[]
  }
  const out: DiscoveredRoute[] = []
  walkStack(router.stack ?? [], mountPath, mountTier, out)
  return out
}
