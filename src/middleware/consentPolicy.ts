/**
 * Consent Policy Express Middleware (#510, #819)
 */

import { Request, Response, NextFunction } from 'express'
import {
  HighRiskWorkflow,
  ConsentScope,
  WORKFLOW_CONSENT_REQUIREMENTS,
  validateWorkflowConsent,
  AuditableBypassReason,
  CONSENT_POLICY_VERSION,
  purposesHashFor,
  UserConsents,
} from '../privacy/consentPolicy'

export interface ConsentRequest extends Request {
  userConsents?: UserConsents
  consentBypass?: {
    reason: AuditableBypassReason
    justification: string
  }
}

function isAuthorizedBypassCaller(req: Request, res: Response): boolean {
  if (res.locals?.adminAuth) return true
  const auth = (req as any).auth || (req as any).user
  if (
    auth &&
    (auth.role === 'admin' || auth.role === 'operator' || auth.isAdmin === true)
  ) {
    return true
  }
  return false
}

/**
 * Express middleware to enforce user consent policy on high-risk workflow endpoints.
 */
export function requireConsentPolicy(
  workflow: HighRiskWorkflow,
  customScope?: ConsentScope
) {
  const requiredScope = customScope || WORKFLOW_CONSENT_REQUIREMENTS[workflow]

  return (req: ConsentRequest, res: Response, next: NextFunction): void => {
    const userId = (req as any).user?.id || (req as any).userId || 'anonymous'
    const userConsents = req.userConsents || (req as any).user?.consents || {}

    // Check for server-side or header-based bypass (#819)
    const serverBypass = req.consentBypass || (res.locals as any)?.consentBypass

    const bypassReasonHeader = req.headers['x-consent-bypass-reason'] as
      AuditableBypassReason | undefined
    const bypassJustificationHeader = req.headers[
      'x-consent-bypass-justification'
    ] as string | undefined

    let bypassReason: AuditableBypassReason | undefined
    let bypassJustification: string | undefined

    if (serverBypass) {
      bypassReason = serverBypass.reason
      bypassJustification = serverBypass.justification
    } else if (bypassReasonHeader) {
      // Ordinary users cannot bypass consent with headers; only verified admin/operator callers
      if (!isAuthorizedBypassCaller(req, res)) {
        res.status(403).json({
          error: 'Consent Policy Violation',
          code: 'CONSENT_BYPASS_UNAUTHORIZED',
          workflow,
          requiredScope,
          reason:
            'Header-based consent bypass is forbidden for non-admin callers',
        })
        return
      }
      bypassReason = bypassReasonHeader
      bypassJustification = bypassJustificationHeader
    }

    const validation = validateWorkflowConsent({
      userId,
      workflow,
      requiredScope,
      userConsents,
      bypassReason,
      bypassJustification,
    })

    if (!validation.allowed && validation.reconsentRequired) {
      res.status(403).json({
        error: 'Consent Policy Violation',
        code: 'CONSENT_RECONSENT_REQUIRED',
        workflow,
        requiredScope,
        policyVersion: CONSENT_POLICY_VERSION,
        purposesHash: purposesHashFor(requiredScope),
        reason: validation.reason,
      })
      return
    }

    if (!validation.allowed) {
      res.status(403).json({
        error: 'Consent Policy Violation',
        code: 'CONSENT_POLICY_DENIED',
        workflow,
        requiredScope,
        reason: validation.reason,
      })
      return
    }

    res.locals.consentValidation = validation
    next()
  }
}
