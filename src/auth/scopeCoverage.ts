/**
 * Which endpoints each scope actually covers (#615).
 *
 * The scope catalogues (src/auth/scopes.ts, src/middleware/adminAuth.ts)
 * describe what a scope MEANS. This module answers the other half: which
 * endpoints it unlocks. The answer is derived from the real route table by
 * reading the scope tag off each route's middleware chain, so it cannot
 * drift — a route that stops requiring a scope stops appearing under it.
 *
 * The route table lives in src/routes/registry.ts, which imports the route
 * files — including the admin route that serves this catalogue. Requiring it
 * lazily inside the function (rather than at module load) breaks that cycle:
 * by the time the coverage is first computed, the whole module graph is
 * loaded.
 */

import { guardScopes } from '../middleware/apiKeyAuth'
import { adminGuardScope } from '../middleware/adminAuth'
import type { ScopeCatalogEntry } from './scopeCatalog'
import { USER_SCOPE_CATALOG, type UserScope } from './scopes'
import { ADMIN_SCOPE_CATALOG, type AdminScope } from '../middleware/adminAuth'

export interface ScopeCoverage {
  /** `METHOD /path` per scope, for both scope families. */
  user: Record<string, string[]>
  admin: Record<string, string[]>
}

let cached: ScopeCoverage | null = null

/** Read the scope tags off a route's middleware chain. */
function scopesOfRoute(routeStack: any[]): {
  user: UserScope[]
  admin: AdminScope[]
} {
  const user: UserScope[] = []
  const admin: AdminScope[] = []

  for (const layer of routeStack) {
    const handler = layer?.handle
    const required = guardScopes(handler)
    if (required) user.push(...required)
    const adminScope = adminGuardScope(handler)
    if (adminScope) admin.push(adminScope)
  }

  return { user, admin }
}

/**
 * Walk the route table and collect, per scope, the endpoints it covers.
 * Memoised — the route table does not change at runtime.
 */
export function getScopeCoverage(): ScopeCoverage {
  if (cached) return cached

  // Required lazily: src/routes/registry.ts imports the admin route, which
  // serves this catalogue. See the module comment.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { API_ROUTES, EXTRA_MOUNTS } = require('../routes/registry') as {
    API_ROUTES: { path: string; handlers: any[] }[]
    EXTRA_MOUNTS: { path: string; handlers: any[] }[]
  }

  const user: Record<string, string[]> = {}
  const admin: Record<string, string[]> = {}

  const walk = (
    stack: any[],
    prefix: string,
    onRoute: (method: string, path: string, routeStack: any[]) => void
  ) => {
    for (const layer of stack) {
      if (layer.route) {
        for (const method of Object.keys(layer.route.methods || {})) {
          const path = (prefix + (layer.route.path || '')).replace(/\/$/, '')
          onRoute(method.toUpperCase(), path || '/', layer.route.stack || [])
        }
      } else if (layer.name === 'router' && layer.handle?.stack) {
        const nested = layer.regexp.source
          .replace(/^\^/, '')
          .replace(/\\\/\?\(\?=\\\/\|\$\)$/, '')
          .replace(/\\\//g, '/')
          .replace(/\(\?:[^)]*\)/g, ':p')
          .replace(/\([^)]*\)/g, ':p')
        walk(
          layer.handle.stack,
          prefix + (nested === '/' ? '' : nested),
          onRoute
        )
      }
    }
  }

  const collect = (
    mounts: { path: string; handlers: any[] }[],
    prefix: string
  ) => {
    for (const mount of mounts) {
      const router = mount.handlers[mount.handlers.length - 1]
      walk(
        router?.stack ?? [],
        prefix + mount.path,
        (method, path, routeStack) => {
          const { user: userScopes, admin: adminScopes } =
            scopesOfRoute(routeStack)
          for (const scope of userScopes) {
            ;(user[scope] ??= []).push(`${method} ${path}`)
          }
          for (const scope of adminScopes) {
            ;(admin[scope] ??= []).push(`${method} ${path}`)
          }
        }
      )
    }
  }

  collect(API_ROUTES, '/api/v1/')
  collect(EXTRA_MOUNTS, '')

  for (const endpoints of Object.values(user)) endpoints.sort()
  for (const endpoints of Object.values(admin)) endpoints.sort()

  cached = { user, admin }
  return cached
}

/** The user scope catalogue, with the endpoints each scope covers. */
export function getUserScopeCatalog(): ScopeCatalogEntry[] {
  const coverage = getScopeCoverage()
  return Object.values(USER_SCOPE_CATALOG).map((definition) => ({
    ...definition,
    endpoints: coverage.user[definition.scope] ?? [],
  }))
}

/** The admin scope catalogue, with the endpoints each scope covers. */
export function getAdminScopeCatalog(): ScopeCatalogEntry[] {
  const coverage = getScopeCoverage()
  return Object.values(ADMIN_SCOPE_CATALOG).map((definition) => ({
    ...definition,
    endpoints: coverage.admin[definition.scope] ?? [],
  }))
}

/** Test seam: drop the memoised coverage so a re-imported table is re-walked. */
export function resetScopeCoverageCache(): void {
  cached = null
}
