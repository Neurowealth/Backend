/**
 * Consent Policy Express Middleware (#510)
 */

import { Request, Response, NextFunction } from 'express'
import {
  HighRiskWorkflow,
  ConsentScope,
  WORKFLOW_CONSENT_REQUIREMENTS,
  validateWorkflowConsent,
  AuditableBypassReason,
} from '../privacy/consentPolicy'

export interface ConsentRequest extends Request {
  userConsents?: Record<ConsentScope, boolean>
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

    const bypassReasonHeader = req.headers['x-consent-bypass-reason'] as
      AuditableBypassReason | undefined
    const bypassJustificationHeader = req.headers[
      'x-consent-bypass-justification'
    ] as string | undefined

    const validation = validateWorkflowConsent({
      userId,
      workflow,
      requiredScope,
      userConsents,
      bypassReason: bypassReasonHeader,
      bypassJustification: bypassJustificationHeader,
    })

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
