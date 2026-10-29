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
})
