/**
 * Unit tests for User Consent and Data-Processing Policy Engine (#510)
 */

import {
  validateWorkflowConsent,
  WORKFLOW_CONSENT_REQUIREMENTS,
  CONSENT_POLICY_VERSION,
  CONSENT_PURPOSES,
  grantConsent,
  purposesHashFor,
  withdrawConsent,
  ConsentRecord,
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

  describe('consent versioning', () => {
    const staleRecord = (scope: ConsentScope): ConsentRecord => ({
      granted: true,
      policyVersion: '0',
      purposesHash: purposesHashFor(scope, {
        ...CONSENT_PURPOSES,
        [scope]: 'An earlier wording of this purpose.',
      }),
      updatedAt: '2026-01-01T00:00:00.000Z',
      history: [],
    })

    it('hashes each scope purpose differently', () => {
      const hashes = new Set(
        (Object.keys(CONSENT_PURPOSES) as ConsentScope[]).map((scope) =>
          purposesHashFor(scope)
        )
      )
      expect(hashes.size).toBe(Object.keys(CONSENT_PURPOSES).length)
    })

    it('stamps grants with the current policy version and purposes hash', () => {
      const record = grantConsent('consent:marketing')

      expect(record.granted).toBe(true)
      expect(record.policyVersion).toBe(CONSENT_POLICY_VERSION)
      expect(record.purposesHash).toBe(purposesHashFor('consent:marketing'))
    })

    it('allows a versioned consent granted under the current purposes', () => {
      const result = validateWorkflowConsent({
        userId,
        workflow: 'NOTIFICATIONS_MARKETING',
        requiredScope: 'consent:marketing',
        userConsents: {
          'consent:marketing': grantConsent('consent:marketing'),
        },
      })

      expect(result.allowed).toBe(true)
      expect(result.reconsentRequired).toBeUndefined()
    })

    it('blocks a consent given under an older version of the purpose', () => {
      const result = validateWorkflowConsent({
        userId,
        workflow: 'NOTIFICATIONS_MARKETING',
        requiredScope: 'consent:marketing',
        userConsents: { 'consent:marketing': staleRecord('consent:marketing') },
      })

      expect(result.allowed).toBe(false)
      expect(result.reconsentRequired).toBe(true)
      expect(result.reason).toContain('re-consent is required')
    })

    it('only invalidates the scopes whose purpose changed', () => {
      const userConsents = {
        'consent:marketing': staleRecord('consent:marketing'),
        'consent:telemetry': grantConsent('consent:telemetry'),
      }

      const marketing = validateWorkflowConsent({
        userId,
        workflow: 'NOTIFICATIONS_MARKETING',
        requiredScope: 'consent:marketing',
        userConsents,
      })
      const telemetry = validateWorkflowConsent({
        userId,
        workflow: 'TELEMETRY_COLLECTION',
        requiredScope: 'consent:telemetry',
        userConsents,
      })

      expect(marketing.allowed).toBe(false)
      expect(telemetry.allowed).toBe(true)
    })

    it('reopens access once the user re-consents', () => {
      const stale = staleRecord('consent:marketing')
      const before = validateWorkflowConsent({
        userId,
        workflow: 'NOTIFICATIONS_MARKETING',
        requiredScope: 'consent:marketing',
        userConsents: { 'consent:marketing': stale },
      })
      const after = validateWorkflowConsent({
        userId,
        workflow: 'NOTIFICATIONS_MARKETING',
        requiredScope: 'consent:marketing',
        userConsents: {
          'consent:marketing': grantConsent('consent:marketing', stale),
        },
      })

      expect(before.allowed).toBe(false)
      expect(after.allowed).toBe(true)
    })

    it('does not treat a withdrawn consent as a re-consent case', () => {
      const result = validateWorkflowConsent({
        userId,
        workflow: 'NOTIFICATIONS_MARKETING',
        requiredScope: 'consent:marketing',
        userConsents: {
          'consent:marketing': withdrawConsent(
            'consent:marketing',
            grantConsent('consent:marketing')
          ),
        },
      })

      expect(result.allowed).toBe(false)
      expect(result.reconsentRequired).toBeUndefined()
    })

    it('records grants and withdrawals in order without mutating the input', () => {
      const granted = grantConsent(
        'consent:telemetry',
        undefined,
        new Date('2026-02-01T00:00:00.000Z')
      )
      const withdrawn = withdrawConsent(
        'consent:telemetry',
        granted,
        new Date('2026-03-01T00:00:00.000Z')
      )

      expect(granted.history).toHaveLength(1)
      expect(withdrawn.granted).toBe(false)
      expect(withdrawn.history.map((e) => e.action)).toEqual([
        'granted',
        'withdrawn',
      ])
      expect(withdrawn.history[1].at).toBe('2026-03-01T00:00:00.000Z')
    })

    it('lets an auditable bypass through a stale consent', () => {
      const result = validateWorkflowConsent({
        userId,
        workflow: 'NOTIFICATIONS_MARKETING',
        requiredScope: 'consent:marketing',
        userConsents: { 'consent:marketing': staleRecord('consent:marketing') },
        bypassReason: 'LEGAL_COMPLIANCE_HOLD',
        bypassJustification: 'Legal hold requires notice delivery to the user',
      })

      expect(result.allowed).toBe(true)
      expect(result.bypassed).toBe(true)
    })
  })
})
