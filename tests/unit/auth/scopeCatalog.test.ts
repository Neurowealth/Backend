/**
 * The scope catalogue must describe the scopes the code actually uses (#615).
 *
 * Before this, the valid scopes were two bare string arrays and the meaning
 * of each scope was a comment or a doc line. That left three gaps this file
 * closes:
 *
 *   - a `requireScope('...')` / `requireAdminScope('...')` call site naming a
 *     scope that is not in the catalogue would be a runtime 403 on a live
 *     route rather than a build failure;
 *   - a catalogue entry no route required would advertise a permission the
 *     platform does not actually grant;
 *   - the "endpoints covered" list could drift from the route table.
 *
 * The endpoint lists are derived from the real route table by reading the
 * scope tag off each route's middleware chain, so the check below compares
 * the catalogue against what the code does — not against a second
 * hand-written list.
 */

import fs from 'fs'
import path from 'path'
import {
  USER_SCOPES,
  USER_SCOPE_CATALOG,
  DEFAULT_READ_SCOPES,
  type UserScope,
} from '../../../src/auth/scopes'
import {
  ADMIN_SCOPES,
  ADMIN_SCOPE_CATALOG,
  ADMIN_GRANTOR_SCOPES,
  hasAdminScope,
  type AdminScope,
} from '../../../src/middleware/adminAuth'
import {
  getAdminScopeCatalog,
  getScopeCoverage,
  getUserScopeCatalog,
} from '../../../src/auth/scopeCoverage'
import { renderScopeCatalogMarkdown } from '../../../src/auth/scopeCatalog'

const ROOT = path.join(__dirname, '../../..')
const DOC_PATH = path.join(ROOT, 'docs', 'API_KEYS.md')

describe('scope catalogue coverage (#615)', () => {
  const coverage = getScopeCoverage()

  it('finds the scope guards in the route table', () => {
    // If the walk silently found nothing, every assertion below would pass
    // vacuously — so pin that it found the well-known guards.
    expect(coverage.user['withdraw:write']?.length ?? 0).toBeGreaterThan(0)
    expect(coverage.admin['keys:write']?.length ?? 0).toBeGreaterThan(0)
  })

  it('describes every user scope', () => {
    for (const scope of USER_SCOPES) {
      expect(USER_SCOPE_CATALOG[scope]).toBeDefined()
      expect(USER_SCOPE_CATALOG[scope].scope).toBe(scope)
      expect(USER_SCOPE_CATALOG[scope].description.length).toBeGreaterThan(0)
      expect(USER_SCOPE_CATALOG[scope].grants.length).toBeGreaterThan(0)
    }
  })

  it('describes every admin scope', () => {
    for (const scope of ADMIN_SCOPES) {
      expect(ADMIN_SCOPE_CATALOG[scope]).toBeDefined()
      expect(ADMIN_SCOPE_CATALOG[scope].scope).toBe(scope)
      expect(ADMIN_SCOPE_CATALOG[scope].description.length).toBeGreaterThan(0)
      expect(ADMIN_SCOPE_CATALOG[scope].grants.length).toBeGreaterThan(0)
    }
  })

  it('uses only catalogued scopes at the call sites', () => {
    // The heart of the check: a scope guard may only name a scope the
    // catalogue describes.
    const unknownUser = Object.keys(coverage.user).filter(
      (scope) => !USER_SCOPES.includes(scope as UserScope)
    )
    const unknownAdmin = Object.keys(coverage.admin).filter(
      (scope) => !ADMIN_SCOPES.includes(scope as AdminScope)
    )
    expect(unknownUser.join(', ')).toBe('')
    expect(unknownAdmin.join(', ')).toBe('')
  })

  it('has no catalogue entry that no route requires', () => {
    // A scope nothing requires must be DECLARED as such. The catalogue must
    // not imply that granting a scope restricts something when no route
    // checks it — an operator reading the catalogue would otherwise believe
    // the platform enforces a promise it does not keep.
    const wrongUser = USER_SCOPES.filter(
      (scope) =>
        (coverage.user[scope]?.length ?? 0) === 0 &&
        USER_SCOPE_CATALOG[scope].enforcement !== 'declared-only'
    )
    const wrongAdmin = ADMIN_SCOPES.filter(
      (scope) =>
        (coverage.admin[scope]?.length ?? 0) === 0 &&
        ADMIN_SCOPE_CATALOG[scope].enforcement !== 'declared-only'
    )
    expect(wrongUser.join(', ')).toBe('')
    expect(wrongAdmin.join(', ')).toBe('')
  })

  it('marks every scope a route requires as enforced', () => {
    // The mirror image: a scope that IS required must say so, so the
    // catalogue cannot quietly downgrade a live guard to "declared only".
    const wrongUser = USER_SCOPES.filter(
      (scope) =>
        (coverage.user[scope]?.length ?? 0) > 0 &&
        USER_SCOPE_CATALOG[scope].enforcement !== 'enforced'
    )
    const wrongAdmin = ADMIN_SCOPES.filter(
      (scope) =>
        (coverage.admin[scope]?.length ?? 0) > 0 &&
        ADMIN_SCOPE_CATALOG[scope].enforcement !== 'enforced'
    )
    expect(wrongUser.join(', ')).toBe('')
    expect(wrongAdmin.join(', ')).toBe('')
  })

  it('publishes exactly the scopes the runtime actually grants', () => {
    // A catalogue that claims `super` implies a scope the auth check does
    // not grant would be a promise the platform breaks. The catalogue's
    // `implies` list is checked against hasAdminScope, which is the code
    // that decides.
    for (const [grantor, implied] of Object.entries(ADMIN_GRANTOR_SCOPES)) {
      for (const scope of implied) {
        expect(
          hasAdminScope(
            { id: 'k', name: 'k', role: 'r', scopes: [grantor] },
            scope
          )
        ).toBe(true)
      }
    }
  })

  it('classifies the grantor scopes correctly', () => {
    // `super` gates routes AND grants other scopes; `agent` only grants.
    // The catalogue has to say which, or an operator cannot tell whether
    // granting it restricts anything.
    expect(ADMIN_SCOPE_CATALOG.super.implies).toEqual(
      ADMIN_GRANTOR_SCOPES.super
    )
    expect(ADMIN_SCOPE_CATALOG.agent.implies).toEqual(
      ADMIN_GRANTOR_SCOPES.agent
    )
    expect(ADMIN_SCOPE_CATALOG.agent.enforcement).toBe('declared-only')
    expect(ADMIN_SCOPE_CATALOG.super.enforcement).toBe('enforced')
  })

  it('attributes every scope-guarded route to exactly one catalogue entry', () => {
    for (const entry of getUserScopeCatalog()) {
      expect(entry.endpoints).toEqual(coverage.user[entry.scope] ?? [])
    }
    for (const entry of getAdminScopeCatalog()) {
      expect(entry.endpoints).toEqual(coverage.admin[entry.scope] ?? [])
    }
  })

  it('does not list the same endpoint twice for one scope', () => {
    for (const [scope, endpoints] of Object.entries(coverage.user)) {
      expect(new Set(endpoints).size).toBe(endpoints.length)
      expect(scope.length).toBeGreaterThan(0)
    }
    for (const [scope, endpoints] of Object.entries(coverage.admin)) {
      expect(new Set(endpoints).size).toBe(endpoints.length)
      expect(scope.length).toBeGreaterThan(0)
    }
  })

  it('keeps the default read scopes inside the catalogue', () => {
    for (const scope of DEFAULT_READ_SCOPES) {
      expect(USER_SCOPES).toContain(scope)
    }
  })
})

describe('scope catalogue API (#615)', () => {
  it('exposes the catalogue with the endpoints each scope covers', () => {
    const user = getUserScopeCatalog()
    const admin = getAdminScopeCatalog()

    expect(user.length).toBe(USER_SCOPES.length)
    expect(admin.length).toBe(ADMIN_SCOPES.length)

    const withdraw = user.find((e) => e.scope === 'withdraw:write')
    expect(withdraw).toBeDefined()
    expect(withdraw!.risk).toBe('money')
    expect(withdraw!.endpoints.length).toBeGreaterThan(0)
    expect(withdraw!.requires).toMatch(/allowWithdrawals/i)
  })

  it('marks the irreversible scopes as destructive', () => {
    const erasure = getAdminScopeCatalog().find(
      (e) => e.scope === 'erasure:write'
    )
    expect(erasure?.risk).toBe('destructive')
    expect(erasure?.requires).toBeTruthy()
  })

  it('lists only read scopes in the default read set', () => {
    for (const scope of DEFAULT_READ_SCOPES) {
      expect(USER_SCOPE_CATALOG[scope].risk).toBe('read')
    }
  })
})

describe('docs/API_KEYS.md scope catalogue (#615)', () => {
  const doc = fs.existsSync(DOC_PATH) ? fs.readFileSync(DOC_PATH, 'utf8') : ''

  it('contains the generated user scope table', () => {
    expect(doc).toContain(renderScopeCatalogMarkdown(getUserScopeCatalog()))
  })

  it('contains the generated admin scope table', () => {
    expect(doc).toContain(renderScopeCatalogMarkdown(getAdminScopeCatalog()))
  })
})
