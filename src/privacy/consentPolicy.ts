/**
 * User Consent and Data-Processing Policy Engine (#510)
 *
 * Defines explicit consent boundaries for high-risk workflows, validates consent policies,
 * and handles auditable policy exceptions/bypasses.
 */

import crypto from 'node:crypto'
import { logger } from '../utils/logger'

export type HighRiskWorkflow =
  | 'AUTOMATED_TRADING'
  | 'PROFILE_ANALYTICS'
  | 'THIRD_PARTY_EXPORT'
  | 'NOTIFICATIONS_MARKETING'
  | 'AI_PORTFOLIO_ADVISORY'
  | 'TELEMETRY_COLLECTION'

export type ConsentScope =
  | 'consent:automated_trading'
  | 'consent:data_processing'
  | 'consent:third_party_sharing'
  | 'consent:marketing'
  | 'consent:ai_advisory'
  | 'consent:telemetry'

export type ConsentAction = 'granted' | 'withdrawn'

/** One grant or withdrawal, pinned to the policy revision it happened under. */
export interface ConsentHistoryEntry {
  action: ConsentAction
  policyVersion: string
  purposesHash: string
  at: string
}

/**
 * A versioned consent for a single scope. `purposesHash` identifies the
 * purpose text the user agreed to; the consent stops counting once the
 * current purpose text for that scope hashes differently.
 */
export interface ConsentRecord {
  granted: boolean
  policyVersion: string
  purposesHash: string
  updatedAt: string
  history: ConsentHistoryEntry[]
}

/**
 * A stored consent. A bare boolean is the legacy, unversioned form and is
 * honoured as-is; new records should be a `ConsentRecord`.
 */
export type StoredConsent = boolean | ConsentRecord

export type UserConsents = Partial<Record<ConsentScope, StoredConsent>>

export interface UserConsentProfile {
  userId: string
  consents: UserConsents
  updatedAt: string
}

export type AuditableBypassReason =
  | 'LEGAL_COMPLIANCE_HOLD'
  | 'EMERGENCY_CIRCUIT_BREAKER'
  | 'SECURITY_AUDIT_OVERRIDE'
  | 'SYSTEM_ADMIN_MAINTENANCE'

export interface ConsentValidationOptions {
  userId: string
  workflow: HighRiskWorkflow
  requiredScope: ConsentScope
  userConsents?: UserConsents
  bypassReason?: AuditableBypassReason
  bypassJustification?: string
}

export interface ConsentValidationResult {
  allowed: boolean
  workflow: HighRiskWorkflow
  requiredScope: ConsentScope
  bypassed: boolean
  bypassReason?: AuditableBypassReason
  reason?: string
  /** True when consent was given, but to a purpose text that has since changed. */
  reconsentRequired?: boolean
}

/** Mapping of high-risk workflows to their mandatory consent scope */
export const WORKFLOW_CONSENT_REQUIREMENTS: Record<
  HighRiskWorkflow,
  ConsentScope
> = {
  AUTOMATED_TRADING: 'consent:automated_trading',
  PROFILE_ANALYTICS: 'consent:data_processing',
  THIRD_PARTY_EXPORT: 'consent:third_party_sharing',
  NOTIFICATIONS_MARKETING: 'consent:marketing',
  AI_PORTFOLIO_ADVISORY: 'consent:ai_advisory',
  TELEMETRY_COLLECTION: 'consent:telemetry',
}

/**
 * Revision of the consent policy. Bump it whenever a purpose below changes in
 * a way users must agree to again; it is recorded on every grant and
 * withdrawal so the history shows which revision a consent belongs to.
 */
export const CONSENT_POLICY_VERSION = '1'

/**
 * The purpose each consent scope authorises. Editing a string here changes
 * that scope's `purposesHash`, which invalidates existing consents for that
 * scope only. Keep in sync with docs/CONSENT_AND_PRIVACY_POLICY.md.
 */
export const CONSENT_PURPOSES: Record<ConsentScope, string> = {
  'consent:automated_trading':
    "Authorizes background agent loops to place orders and execute strategy transactions on user's behalf.",
  'consent:data_processing':
    'Authorizes collection and processing of financial history for personalized analytics.',
  'consent:third_party_sharing':
    'Authorizes sharing transaction and profile data with third-party service integrators.',
  'consent:marketing': 'Authorizes sending marketing and promotional updates.',
  'consent:ai_advisory':
    'Authorizes processing portfolio state with AI model providers for strategy insights.',
  'consent:telemetry':
    'Authorizes collecting performance telemetry and diagnostic events.',
}

/** Hash of the purpose text a scope currently asks the user to agree to. */
export function purposesHashFor(
  scope: ConsentScope,
  purposes: Record<ConsentScope, string> = CONSENT_PURPOSES
): string {
  return crypto.createHash('sha256').update(purposes[scope]).digest('hex')
}

/**
 * Record a grant, stamped with the current policy version and purposes hash.
 * Returns a new record; `previous` is not modified.
 */
export function grantConsent(
  scope: ConsentScope,
  previous?: ConsentRecord,
  now: Date = new Date()
): ConsentRecord {
  return appendConsentEvent(scope, 'granted', previous, now)
}

/** Record a withdrawal. Returns a new record; `previous` is not modified. */
export function withdrawConsent(
  scope: ConsentScope,
  previous?: ConsentRecord,
  now: Date = new Date()
): ConsentRecord {
  return appendConsentEvent(scope, 'withdrawn', previous, now)
}

function appendConsentEvent(
  scope: ConsentScope,
  action: ConsentAction,
  previous: ConsentRecord | undefined,
  now: Date
): ConsentRecord {
  const at = now.toISOString()
  const policyVersion = CONSENT_POLICY_VERSION
  const purposesHash = purposesHashFor(scope)
  return {
    granted: action === 'granted',
    policyVersion,
    purposesHash,
    updatedAt: at,
    history: [
      ...(previous?.history ?? []),
      { action, policyVersion, purposesHash, at },
    ],
  }
}

/**
 * Validates whether user consent is present for a high-risk operational workflow,
 * or whether an authorized, auditable bypass reason applies.
 */
export function validateWorkflowConsent(
  opts: ConsentValidationOptions
): ConsentValidationResult {
  const {
    userId,
    workflow,
    requiredScope,
    userConsents,
    bypassReason,
    bypassJustification,
  } = opts

  // Check for documented, auditable bypass
  if (bypassReason) {
    if (!bypassJustification || bypassJustification.trim().length < 10) {
      return {
        allowed: false,
        workflow,
        requiredScope,
        bypassed: false,
        reason: `Consent bypass rejected: justification must be at least 10 characters for audit compliance (${bypassReason})`,
      }
    }

    logger.warn(
      '[Consent Policy Audit] High-risk workflow executed under auditable consent bypass:',
      {
        userId,
        workflow,
        requiredScope,
        bypassReason,
        bypassJustification,
        timestamp: new Date().toISOString(),
      }
    )

    return {
      allowed: true,
      workflow,
      requiredScope,
      bypassed: true,
      bypassReason,
    }
  }

  // Validate user consent status
  const stored = userConsents?.[requiredScope]

  if (typeof stored === 'object' && stored !== null && stored.granted) {
    const currentHash = purposesHashFor(requiredScope)
    if (stored.purposesHash !== currentHash) {
      logger.info('[Consent Policy] Consent predates a purpose change:', {
        userId,
        workflow,
        requiredScope,
        consentedPolicyVersion: stored.policyVersion,
        currentPolicyVersion: CONSENT_POLICY_VERSION,
        consentedPurposesHash: stored.purposesHash,
        currentPurposesHash: currentHash,
      })

      return {
        allowed: false,
        workflow,
        requiredScope,
        bypassed: false,
        reconsentRequired: true,
        reason: `User consent '${requiredScope}' was given under policy version '${stored.policyVersion}' and its purpose has since changed; re-consent is required for workflow '${workflow}'`,
      }
    }
  }

  const hasConsent =
    stored === true ||
    (typeof stored === 'object' && stored !== null && stored.granted === true)

  if (!hasConsent) {
    logger.info('[Consent Policy] Workflow consent validation failed:', {
      userId,
      workflow,
      requiredScope,
    })

    return {
      allowed: false,
      workflow,
      requiredScope,
      bypassed: false,
      reason: `Required user consent '${requiredScope}' is missing or revoked for workflow '${workflow}'`,
    }
  }

  return {
    allowed: true,
    workflow,
    requiredScope,
    bypassed: false,
  }
}
