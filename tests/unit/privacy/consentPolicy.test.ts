/**
 * Unit tests for User Consent and Data-Processing Policy Engine (#510)
 */

import {
  validateWorkflowConsent,
  WORKFLOW_CONSENT_REQUIREMENTS,
  ConsentScope,
} from '../../../src/privacy/consentPolicy'

describe('User Consent and Data-Processing Policy Engine (#510)', () => {
  const userId = 'user_test_123'

  it('maps all high-risk workflows to their required consent scopes', () => {
    expect(WORKFLOW_CONSENT_REQUIREMENTS.AUTOMATED_TRADING).toBe(
      'consent:automated_trading'
    )
    expect(WORKFLOW_CONSENT_REQUIREMENTS.PROFILE_ANALYTICS).toBe(
      'consent:data_processing'
    )
    expect(WORKFLOW_CONSENT_REQUIREMENTS.THIRD_PARTY_EXPORT).toBe(
      'consent:third_party_sharing'
    )
    expect(WORKFLOW_CONSENT_REQUIREMENTS.NOTIFICATIONS_MARKETING).toBe(
      'consent:marketing'
    )
    expect(WORKFLOW_CONSENT_REQUIREMENTS.AI_PORTFOLIO_ADVISORY).toBe(
      'consent:ai_advisory'
    )
    expect(WORKFLOW_CONSENT_REQUIREMENTS.TELEMETRY_COLLECTION).toBe(
      'consent:telemetry'
    )
  })

  it('approves workflow when explicit consent is present', () => {
    const userConsents: Record<ConsentScope, boolean> = {
      'consent:automated_trading': true,
      'consent:data_processing': true,
      'consent:third_party_sharing': false,
      'consent:marketing': false,
      'consent:ai_advisory': false,
      'consent:telemetry': false,
    }

    const result = validateWorkflowConsent({
      userId,
      workflow: 'AUTOMATED_TRADING',
      requiredScope: 'consent:automated_trading',
      userConsents,
    })

    expect(result.allowed).toBe(true)
    expect(result.bypassed).toBe(false)
  })

  it('denies workflow when mandatory consent is missing', () => {
    const userConsents: Record<ConsentScope, boolean> = {
      'consent:automated_trading': false,
      'consent:data_processing': true,
      'consent:third_party_sharing': false,
      'consent:marketing': false,
      'consent:ai_advisory': false,
      'consent:telemetry': false,
    }

    const result = validateWorkflowConsent({
      userId,
      workflow: 'AUTOMATED_TRADING',
      requiredScope: 'consent:automated_trading',
      userConsents,
    })

    expect(result.allowed).toBe(false)
    expect(result.reason).toContain(
      "Required user consent 'consent:automated_trading' is missing or revoked"
    )
  })

  it('allows workflow with valid auditable bypass and justification', () => {
    const result = validateWorkflowConsent({
      userId,
      workflow: 'AUTOMATED_TRADING',
      requiredScope: 'consent:automated_trading',
      bypassReason: 'EMERGENCY_CIRCUIT_BREAKER',
      bypassJustification:
        'Market volatility circuit breaker triggered by system risk engine',
    })

    expect(result.allowed).toBe(true)
    expect(result.bypassed).toBe(true)
    expect(result.bypassReason).toBe('EMERGENCY_CIRCUIT_BREAKER')
  })

  it('rejects bypass when justification is insufficient or missing', () => {
    const result = validateWorkflowConsent({
      userId,
      workflow: 'AUTOMATED_TRADING',
      requiredScope: 'consent:automated_trading',
      bypassReason: 'LEGAL_COMPLIANCE_HOLD',
      bypassJustification: 'Too short',
    })

    expect(result.allowed).toBe(false)
    expect(result.reason).toContain(
      'Consent bypass rejected: justification must be at least 10 characters'
    )
  })
})
