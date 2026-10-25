import {
  registerOptionsSchema,
  registerVerifySchema,
  loginVerifySchema,
  credentialIdParamSchema,
} from '../../../src/validators/webauthn-validators'

describe('webauthn-validators', () => {
  it('validates register options schema', () => {
    const valid = { deviceLabel: 'MacBook Pro FaceID' }
    const res = registerOptionsSchema.safeParse(valid)
    expect(res.success).toBe(true)
  })

  it('validates register verify schema', () => {
    const valid = {
      challengeId: 'challenge',
      response: {
        id: 'cred-123',
        rawId: 'cred-123',
        type: 'public-key',
        response: { clientDataJSON: 'e30', attestationObject: 'e30' },
      },
      deviceLabel: 'YubiKey 5C',
    }
    const res = registerVerifySchema.safeParse(valid)
    expect(res.success).toBe(true)
  })

  it('validates login verify schema', () => {
    const valid = {
      userId: '11111111-1111-4111-8111-111111111111',
      challengeId: 'challenge',
      response: {
        id: 'cred-123',
        rawId: 'cred-123',
        type: 'public-key',
        response: {
          clientDataJSON: 'e30',
          authenticatorData: 'e30',
          signature: 'e30',
        },
      },
    }
    const res = loginVerifySchema.safeParse(valid)
    expect(res.success).toBe(true)
  })

  it('requires a challenge and complete assertion instead of arbitrary response data', () => {
    expect(
      loginVerifySchema.safeParse({ response: { id: 'credential' } }).success
    ).toBe(false)
    expect(registerVerifySchema.safeParse({ response: null }).success).toBe(
      false
    )
  })

  it('validates credential id param schema', () => {
    const valid = { id: '11111111-1111-4111-8111-111111111111' }
    const res = credentialIdParamSchema.safeParse(valid)
    expect(res.success).toBe(true)
  })
})
