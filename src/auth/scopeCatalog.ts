/**
 * The shared shape of a scope catalogue entry (#615).
 *
 * A scope is a permission string stored on a credential. Two families exist —
 * user API key scopes (src/auth/scopes.ts) and admin key scopes
 * (src/middleware/adminAuth.ts) — and until this module existed both were
 * bare string arrays: the list of valid scopes lived in code, the meaning of
 * each scope lived in a comment or a doc, and nothing connected the two. A
 * key-creation UI could not show an operator what a scope actually unlocks,
 * and a typo in a `requireScope('...')` call site was a runtime 403 rather
 * than a build failure.
 *
 * This module defines the entry shape both catalogues use, and the renderer
 * that turns a catalogue into the tables in docs/API_KEYS.md.
 */

/**
 * How much a holder of a scope can do.
 *
 *   read         — reads state and nothing else.
 *   write        — mutates state that belongs to the user.
 *   money        — moves value. Needs a second guardrail (an opt-in flag, a
 *                  platform kill-switch) as well as the scope itself.
 *   destructive  — deletes state, irreversibly.
 *   operational  — acts on platform-wide state rather than one user's.
 */
export type ScopeRisk =
  'read' | 'write' | 'money' | 'destructive' | 'operational'

/**
 * Whether a scope actually gates anything.
 *
 * The catalogue has to say this, because a scope that gates nothing is a
 * promise the platform does not keep — an operator reading the catalogue
 * would reasonably believe granting it restricts something.
 *
 *   enforced      — at least one route requires this scope. Granting it is
 *                   meaningful and omitting it is restrictive.
 *   declared-only — declared and reservable, but no route requires it today.
 *                   Granting it currently grants nothing extra; it exists so
 *                   a key can be provisioned ahead of the route that will
 *                   require it.
 *
 * Whether a scope ALSO grants other scopes is a separate question, answered
 * by `implies` — `super` both gates routes and implies every other scope, so
 * the two concerns cannot share one field.
 */
export type ScopeEnforcement = 'enforced' | 'declared-only'

/** The risk levels, ordered least to most powerful — for sorting a UI list. */
export const SCOPE_RISK_ORDER: readonly ScopeRisk[] = [
  'read',
  'write',
  'money',
  'destructive',
  'operational',
] as const

export interface ScopeDefinition {
  /** The scope string exactly as it is stored on the credential. */
  scope: string
  /** One line, written for the key-creation screen. */
  description: string
  /** How much damage a holder of this scope can do. */
  risk: ScopeRisk
  /** What the scope unlocks, in an operator's words. */
  grants: string
  /** Whether a route requires this scope. See ScopeEnforcement. */
  enforcement: ScopeEnforcement
  /**
   * Other scopes this one implicitly grants. `super` implies every scope;
   * the legacy `agent` implies `agent:read` and `agent:write`.
   */
  implies?: readonly string[]
  /**
   * Any guardrail that applies on top of the scope itself — an opt-in flag,
   * a platform kill-switch, a dual-control approval. Present only when the
   * scope is not sufficient on its own.
   */
  requires?: string
}

/**
 * A catalogue entry plus the endpoints it actually covers.
 *
 * The endpoint list is derived from the route table rather than hand-written
 * (src/auth/scopeCoverage.ts), so it cannot drift: if a route stops requiring
 * a scope, the scope stops claiming to cover it.
 */
export interface ScopeCatalogEntry extends ScopeDefinition {
  /** `METHOD /path` for every route that requires this scope. */
  endpoints: string[]
}

/** Sort a catalogue by risk, then alphabetically — the order a UI wants. */
export function sortScopeEntries<T extends ScopeDefinition>(entries: T[]): T[] {
  return [...entries].sort((a, b) => {
    const byRisk =
      SCOPE_RISK_ORDER.indexOf(a.risk) - SCOPE_RISK_ORDER.indexOf(b.risk)
    if (byRisk !== 0) return byRisk
    return a.scope.localeCompare(b.scope)
  })
}

/** Render a catalogue as a Markdown table — the table in docs/API_KEYS.md. */
export function renderScopeCatalogMarkdown(
  entries: ScopeCatalogEntry[],
  options: { showEndpoints?: boolean } = {}
): string {
  const showEndpoints = options.showEndpoints ?? true
  const header = showEndpoints
    ? '| Scope | Risk | Enforcement | Implies | What it does | Guardrail | Endpoints |'
    : '| Scope | Risk | Enforcement | Implies | What it does | Guardrail |'
  const divider = showEndpoints
    ? '| --- | --- | --- | --- | --- | --- | --- |'
    : '| --- | --- | --- | --- | --- | --- |'
  const rows = sortScopeEntries(entries).map((entry) => {
    const implies = entry.implies?.length
      ? entry.implies.map((s) => `\`${s}\``).join(', ')
      : '—'
    const base = `| \`${entry.scope}\` | ${entry.risk} | ${entry.enforcement} | ${implies} | ${entry.description} | ${entry.requires ?? '—'} |`
    if (!showEndpoints) return base
    const endpoints = entry.endpoints.length
      ? entry.endpoints.map((e) => `\`${e}\``).join(', ')
      : '—'
    return `${base} ${endpoints} |`
  })
  return [header, divider, ...rows].join('\n')
}
