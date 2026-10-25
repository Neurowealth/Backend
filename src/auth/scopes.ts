/**
 * User API key scope catalog (#374, #615).
 *
 * Sessions implicitly grant `*` (all scopes). API keys are limited to the
 * scopes explicitly assigned at creation time.
 *
 * The catalogue below is the machine-readable form of that rule set: it says
 * what each scope means, how risky it is, and what else has to be true before
 * it can be used. `GET /api/admin/keys/scopes` serves it for the
 * key-creation UI, docs/API_KEYS.md renders it, and
 * tests/unit/auth/scopeCatalog.test.ts fails CI if a `requireScope('...')`
 * call site names a scope that is not in here.
 */

import type { ScopeDefinition } from './scopeCatalog'

export const USER_SCOPES = [
  'portfolio:read',
  'portfolio:write',
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
  // #532 — collateral loans. Borrowing and repaying are money movement, so
  // they are deliberately NOT folded into `withdraw:write`: a key trusted to
  // read a portfolio or to pull funds out should not thereby gain the power to
  // pledge the user's collateral. `loans:read` is a read scope, and
  // `loans:write` covers both origination and repayment.
  'loans:read',
  'loans:write',
] as const

export type UserScope = (typeof USER_SCOPES)[number]

/**
 * What each user scope means.
 *
 * Every scope in USER_SCOPES must have an entry here — the catalogue is
 * typed as a total map, so a new scope cannot be added without describing
 * it.
 */
export const USER_SCOPE_CATALOG: Record<UserScope, ScopeDefinition> = {
  'portfolio:read': {
    scope: 'portfolio:read',
    enforcement: 'enforced',
    description:
      'Read portfolio positions, balances, history, earnings and tax reports.',
    risk: 'read',
    grants:
      'The user’s portfolio, allocation suggestions, earnings and tax report.',
  },
  'portfolio:write': {
    scope: 'portfolio:write',
    enforcement: 'enforced',
    description: 'Change portfolio state.',
    risk: 'write',
    grants: 'Mutations of the user’s own portfolio.',
  },
  'transactions:read': {
    scope: 'transactions:read',
    enforcement: 'enforced',
    description: 'Read transaction history.',
    risk: 'read',
    grants: 'Transaction list and per-transaction events.',
  },
  'deposit:write': {
    scope: 'deposit:write',
    enforcement: 'enforced',
    description: 'Create deposits.',
    risk: 'money',
    grants: 'Submits deposits to the durable outbox for on-chain settlement.',
    requires:
      'Deposits still pass the compliance freeze and sub-account permission checks.',
  },
  'withdraw:write': {
    scope: 'withdraw:write',
    enforcement: 'enforced',
    description: 'Create withdrawals.',
    risk: 'money',
    grants:
      'Submits withdrawals to the durable outbox for on-chain settlement.',
    requires:
      'Requires allowWithdrawals on the key AND the platform kill-switch ' +
      'USER_API_KEY_WITHDRAWALS_ENABLED to be on.',
  },
  'alerts:manage': {
    scope: 'alerts:manage',
    enforcement: 'enforced',
    description: 'Manage alert rules.',
    risk: 'write',
    grants: 'Create, update and delete the user’s alert rules.',
  },
  'fiat:write': {
    scope: 'fiat:write',
    enforcement: 'enforced',
    description: 'Create fiat on/off-ramp orders.',
    risk: 'money',
    grants: 'Submits fiat orders to the configured provider.',
  },
  'recurring_deposits:write': {
    scope: 'recurring_deposits:write',
    enforcement: 'enforced',
    description: 'Manage recurring deposit plans.',
    risk: 'money',
    grants: 'Schedules and cancels recurring deposits.',
  },
  'goals:write': {
    scope: 'goals:write',
    enforcement: 'enforced',
    description: 'Manage savings goals.',
    risk: 'write',
    grants: 'Create, update and delete savings goals.',
  },
  'strategies:write': {
    scope: 'strategies:write',
    enforcement: 'enforced',
    description: 'Publish, follow and unfollow strategies.',
    risk: 'write',
    grants: 'Publishes the user’s own strategy and manages follows.',
  },
  'webhooks:manage': {
    scope: 'webhooks:manage',
    enforcement: 'enforced',
    description: 'Manage webhook endpoints and deliveries.',
    risk: 'write',
    grants:
      'Registers endpoints and reads delivery logs. Endpoint secrets are ' +
      'write-only — a response body never carries one back.',
  },
  'vault:read': {
    scope: 'vault:read',
    enforcement: 'enforced',
    description: 'Read vault state and balance.',
    risk: 'read',
    grants: 'The user’s vault state and balance.',
  },
  'vault:write': {
    scope: 'vault:write',
    enforcement: 'enforced',
    description: 'Build vault transactions.',
    risk: 'money',
    grants: 'Builds (but does not sign) vault operations.',
  },
  'loans:read': {
    scope: 'loans:read',
    enforcement: 'enforced',
    description: 'Read loan state and borrowing capacity.',
    risk: 'read',
    grants: 'Loan list, per-loan detail and available capacity.',
  },
  'loans:write': {
    scope: 'loans:write',
    enforcement: 'enforced',
    description: 'Originate and repay collateral loans.',
    risk: 'money',
    grants:
      'Pledges collateral and borrows, or repays an existing loan. ' +
      'Deliberately separate from withdraw:write so a key trusted to pull ' +
      'funds out cannot thereby pledge the user’s collateral.',
    requires:
      'Origination and repayment still pass the compliance freeze and ' +
      'sub-account permission checks.',
  },
}

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
