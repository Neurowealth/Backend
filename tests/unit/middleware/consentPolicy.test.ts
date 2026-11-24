import type { Response, NextFunction } from 'express'
import { requireConsentPolicy } from '../../../src/middleware/consentPolicy'
import type { ConsentRequest } from '../../../src/middleware/consentPolicy'
import {
  CONSENT_POLICY_VERSION,
  CONSENT_PURPOSES,
  grantConsent,
  purposesHashFor,
} from '../../../src/privacy/consentPolicy'
import type { ConsentRecord } from '../../../src/privacy/consentPolicy'

describe('requireConsentPolicy re-consent (#668)', () => {
  let res: Partial<Response>
  let next: NextFunction

  beforeEach(() => {
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      locals: {},
    }
    next = jest.fn()
  })

  const run = (userConsents: ConsentRequest['userConsents']) => {
    const req = { headers: {}, userConsents } as unknown as ConsentRequest
    requireConsentPolicy('NOTIFICATIONS_MARKETING')(req, res as Response, next)
  }

  it('lets a current versioned consent through', () => {
    run({ 'consent:marketing': grantConsent('consent:marketing') })

    expect(next).toHaveBeenCalled()
    expect(res.status).not.toHaveBeenCalled()
  })

  it('blocks a stale consent with a re-consent code and the current version', () => {
    const stale: ConsentRecord = {
      granted: true,
      policyVersion: '0',
      purposesHash: purposesHashFor('consent:marketing', {
        ...CONSENT_PURPOSES,
        'consent:marketing': 'An earlier wording of this purpose.',
      }),
      updatedAt: '2026-01-01T00:00:00.000Z',
      history: [],
    }

    run({ 'consent:marketing': stale })

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'CONSENT_RECONSENT_REQUIRED',
        requiredScope: 'consent:marketing',
        policyVersion: CONSENT_POLICY_VERSION,
        purposesHash: purposesHashFor('consent:marketing'),
      })
    )
  })

  it('keeps the existing denial code when consent is simply missing', () => {
    run({})

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'CONSENT_POLICY_DENIED' })
    )
  })

  describe('consent bypass authorization (#819)', () => {
    it('blocks ordinary callers from bypassing consent using headers', () => {
      const req = {
        headers: {
          'x-consent-bypass-reason': 'LEGAL_OBLIGATION',
          'x-consent-bypass-justification':
            'Audit compliance justification of sufficient length',
        },
        userConsents: {},
        user: { id: 'user-1', role: 'user' },
      } as unknown as ConsentRequest

      requireConsentPolicy('NOTIFICATIONS_MARKETING')(
        req,
        res as Response,
        next
      )

      expect(next).not.toHaveBeenCalled()
      expect(res.status).toHaveBeenCalledWith(403)
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'CONSENT_BYPASS_UNAUTHORIZED',
          error: 'Consent Policy Violation',
        })
      )
    })

    it('allows verified admin caller to supply bypass headers', () => {
      const req = {
        headers: {
          'x-consent-bypass-reason': 'LEGAL_OBLIGATION',
          'x-consent-bypass-justification':
            'Court order audit justification exceeding ten chars',
        },
        userConsents: {},
        user: { id: 'admin-1', role: 'admin' },
      } as unknown as ConsentRequest

      requireConsentPolicy('NOTIFICATIONS_MARKETING')(
        req,
        res as Response,
        next
      )

      expect(next).toHaveBeenCalled()
      expect(res.status).not.toHaveBeenCalled()
      expect(res.locals!.consentValidation).toEqual(
        expect.objectContaining({
          allowed: true,
          bypassed: true,
          bypassReason: 'LEGAL_OBLIGATION',
        })
      )
    })

    it('allows server-side caller to supply consentBypass directly', () => {
      const req = {
        headers: {},
        consentBypass: {
          reason: 'FRAUD_PREVENTION',
          justification:
            'Internal fraud investigation justification exceeding ten chars',
        },
        userConsents: {},
      } as unknown as ConsentRequest

      requireConsentPolicy('NOTIFICATIONS_MARKETING')(
        req,
        res as Response,
        next
      )

      expect(next).toHaveBeenCalled()
      expect(res.status).not.toHaveBeenCalled()
      expect(res.locals!.consentValidation).toEqual(
        expect.objectContaining({
          allowed: true,
          bypassed: true,
          bypassReason: 'FRAUD_PREVENTION',
        })
      )
    })
  })
})
