/**
 * User Consent and Data-Processing Policy Engine (#510)
 *
 * Defines explicit consent boundaries for high-risk workflows, validates consent policies,
 * and handles auditable policy exceptions/bypasses.
 */

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

export interface UserConsentProfile {
  userId: string
  consents: Record<ConsentScope, boolean>
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
  userConsents?: Record<ConsentScope, boolean>
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
  const hasConsent = Boolean(
    userConsents && userConsents[requiredScope] === true
  )

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
