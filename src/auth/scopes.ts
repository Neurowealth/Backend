/**
 * User API key scope catalog (#374).
 *
 * Sessions implicitly grant `*` (all scopes). API keys are limited to the
 * scopes explicitly assigned at creation time.
 */

export const USER_SCOPES = [
  'portfolio:read',
  'transactions:read',
  'deposit:write',
  'withdraw:write',
  'alerts:manage',
  'fiat:write',
  'recurring_deposits:write',
  'goals:write',
  'strategies:write',
  'webhooks:manage',
  'vault:read',
  'vault:write',
] as const

export type UserScope = (typeof USER_SCOPES)[number]

export function validateUserScopes(scopes: unknown): scopes is UserScope[] {
  if (!Array.isArray(scopes) || scopes.length === 0) return false
  return scopes.every((s) => USER_SCOPES.includes(s as UserScope))
}

/** Default read-only scope set for new keys. */
export const DEFAULT_READ_SCOPES: UserScope[] = [
  'portfolio:read',
  'transactions:read',
  'vault:read',
]
