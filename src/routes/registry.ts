/**
 * The route table (#614).
 *
 * This is the single list of routers the API mounts, extracted from
 * src/index.ts so that the tier-matrix CI check
 * (tests/unit/middleware/rateLimitTierMatrix.test.ts) can walk the REAL route
 * table — every method and path the server actually serves — instead of a
 * hand-written list that could fall behind the code.
 *
 * The legacy unversioned /api/* aliases are mounted from the same table, so a
 * path listed here is served at BOTH /api/v1/<path> and /api/<path> with the
 * same handlers and therefore the same rate-limit tier.
 */

import { type RequestHandler } from 'express'
import {
  adminRateLimiter,
  authRateLimiter,
  internalRateLimiter,
  webhookRateLimiter,
} from '../middleware/rateLimiter'
import accountingRouter from './accounting'
import agentRouter from './agent'
import agentDecisionsRouter from './agent-decisions'
import adminRouter from './admin'
import adminSupportTicketsRouter from './admin/support-tickets'
import adminRiskMetadataRouter from './admin/risk-metadata'
import adminReferralReviewRouter from './admin/referral-review'
import alertsRouter from './alerts'
import analyticsRouter from './analytics'
import approvalPoliciesRouter from './approval-policies'
import approvalsRouter from './approvals'
import assistantRouter from './assistant'
import authRouter from './auth'
import depositRouter from './deposit'
import fiatRouter from './fiat'
import healthRouter from './health'
import keysRouter from './keys'
import liquidityFloorRouter from './liquidity-floor'
import loansRouter from './loans'
import metricsRouter from './metrics'
import netWorthRouter from './net-worth'
import networkRouter from './network'
import notificationDlqRouter from './notification-dlq'
import notificationsRouter from './notifications'
import portfolioRouter from './portfolio'
import protocolsRouter from './protocols'
import protectionFundRouter from './protection-fund'
import recurringDepositRouter from './recurring-deposits'
import recurringWithdrawalRouter from './recurring-withdrawals'
import referralsRouter from './referrals'
import sessionsRouter from './sessions'
import settingsRouter from './settings'
import stellarRouter from './stellar'
import strategiesRouter from './strategies'
import streamRouter from './stream'
import subAccountsRouter from './sub-accounts'
import supportTicketsRouter from './support-tickets'
import telegramRouter from './telegram'
import transactionsRouter from './transactions'
import vaultRouter from './vault'
import webAuthnRouter from './webauthn'
import webhooksRouter from './webhooks'
import whatsappRouter from './whatsapp'
import withdrawRouter from './withdraw'

export interface ApiRoute {
  /** Path relative to the version prefix — e.g. `deposit` → `/api/v1/deposit`. */
  path: string
  /**
   * The handlers mounted for this path. A rate limiter may appear here, in
   * which case it applies to EVERY route under the mount.
   */
  handlers: RequestHandler[]
}

/**
 * Routers mounted under the versioned `/api/v1/*` prefix, and their legacy
 * `/api/*` aliases.
 *
 * A limiter in `handlers` applies to every route under that mount. Per-route
 * limiters (the `sensitiveRateLimiter` on a single deposit endpoint, say) are
 * attached inside the route file itself — the tier matrix reads them off the
 * route's own middleware chain.
 */
export const API_ROUTES: ApiRoute[] = [
  { path: 'network', handlers: [networkRouter] },
  { path: 'net-worth', handlers: [netWorthRouter] },
  { path: 'agent/decisions', handlers: [agentDecisionsRouter] },
  { path: 'agent', handlers: [internalRateLimiter, agentRouter] },
  { path: 'auth/webauthn', handlers: [authRateLimiter, webAuthnRouter] },
  { path: 'auth', handlers: [authRateLimiter, authRouter] },
  { path: 'webauthn', handlers: [authRateLimiter, webAuthnRouter] },
  { path: 'whatsapp', handlers: [webhookRateLimiter, whatsappRouter] },
  { path: 'telegram', handlers: [webhookRateLimiter, telegramRouter] },
  { path: 'portfolio', handlers: [portfolioRouter] },
  { path: 'transactions', handlers: [transactionsRouter] },
  // #669 — QBO/Xero export with a mandatory ledger reconciliation gate.
  { path: 'accounting', handlers: [accountingRouter] },
  { path: 'protocols', handlers: [protocolsRouter] },
  { path: 'deposit', handlers: [depositRouter] },
  { path: 'withdraw', handlers: [withdrawRouter] },
  // #532 — collateral loans. Mounted beside withdraw rather than inside
  // portfolio: a loan is its own lifecycle with its own approval and rate
  // limits, and it must not inherit portfolio's read-only scope set.
  { path: 'loans', handlers: [loansRouter] },
  // #533 — protocol-risk protection fund
  { path: 'protection-fund', handlers: [protectionFundRouter] },
  // #534 — user settings (display currency)
  { path: 'settings', handlers: [settingsRouter] },
  { path: 'vault', handlers: [vaultRouter] },
  { path: 'analytics', handlers: [analyticsRouter] },
  { path: 'stellar', handlers: [stellarRouter] },
  { path: 'fiat', handlers: [fiatRouter] },
  { path: 'referrals', handlers: [referralsRouter] },
  { path: 'deposit/recurring', handlers: [recurringDepositRouter] },
  { path: 'recurring-withdrawals', handlers: [recurringWithdrawalRouter] },
  { path: 'alerts', handlers: [alertsRouter] },
  { path: 'strategies', handlers: [strategiesRouter] },
  { path: 'sub-accounts', handlers: [subAccountsRouter] },
  { path: 'support/tickets', handlers: [supportTicketsRouter] },
  {
    path: 'admin/support/tickets',
    handlers: [adminRateLimiter, adminSupportTicketsRouter],
  },
  {
    path: 'admin/referrals/fraud',
    handlers: [adminRateLimiter, adminReferralReviewRouter],
  },
  {
    path: 'admin/risk-metadata',
    handlers: [adminRateLimiter, adminRiskMetadataRouter],
  },
  { path: 'assistant', handlers: [assistantRouter] },
  { path: 'approvals', handlers: [approvalsRouter] },
  { path: 'approval-policies', handlers: [approvalPoliciesRouter] },
  { path: 'keys', handlers: [keysRouter] },
  { path: 'sessions', handlers: [sessionsRouter] },
  { path: 'stream', handlers: [streamRouter] },
  { path: 'notifications', handlers: [notificationsRouter] },
  { path: 'liquidity-floor', handlers: [liquidityFloorRouter] },
  {
    path: 'admin/notifications/dlq',
    handlers: [adminRateLimiter, notificationDlqRouter],
  },
  { path: 'admin', handlers: [adminRateLimiter, adminRouter] },
]

/**
 * Routers mounted OUTSIDE the `/api/v1` version scheme.
 *
 * These are either operational endpoints (health, metrics) or the pre-version
 * paths that predate the versioning policy. They are listed here so the tier
 * matrix can describe them too — an endpoint that no one can find in the
 * matrix is an endpoint nobody knows the budget of.
 */
export const EXTRA_MOUNTS: ApiRoute[] = [
  { path: '/health', handlers: [healthRouter] },
  { path: '/api/analytics', handlers: [analyticsRouter] },
  { path: '/api/stellar', handlers: [stellarRouter] },
  { path: '/api/webhooks', handlers: [webhooksRouter] },
  { path: '/metrics', handlers: [metricsRouter] },
]
