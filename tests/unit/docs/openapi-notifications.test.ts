import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

describe('OpenAPI specification - Notifications and Email Verification (#449)', () => {
  const specPath = path.resolve(__dirname, '../../../docs/openapi.yaml')
  const specContent = fs.readFileSync(specPath, 'utf8')
  const spec = yaml.load(specContent) as any

  it('declares the Notifications tag in the tags list', () => {
    const notificationTag = spec.tags.find(
      (tag: { name: string }) => tag.name === 'Notifications'
    )
    expect(notificationTag).toBeDefined()
    expect(notificationTag.name).toBe('Notifications')
    expect(notificationTag.description).toContain('Email verification')
  })

  it('defines the POST /notifications/email endpoint correctly', () => {
    const endpoint = spec.paths['/notifications/email']?.post
    expect(endpoint).toBeDefined()
    expect(endpoint.operationId).toBe('requestEmailVerification')
    expect(endpoint.tags).toContain('Notifications')
    expect(endpoint.security).toEqual([{ bearerAuth: [] }])
    expect(endpoint.requestBody.content['application/json'].schema.$ref).toBe(
      '#/components/schemas/RequestEmailVerificationRequest'
    )
    expect(endpoint.responses['200']).toBeDefined()
    expect(endpoint.responses['400']).toBeDefined()
    expect(endpoint.responses['401']).toBeDefined()
    expect(endpoint.responses['500']).toBeDefined()
  })

  it('defines the GET /notifications/email/verify endpoint correctly', () => {
    const endpoint = spec.paths['/notifications/email/verify']?.get
    expect(endpoint).toBeDefined()
    expect(endpoint.operationId).toBe('verifyEmail')
    expect(endpoint.tags).toContain('Notifications')
    expect(endpoint.security).toEqual([])

    const tokenParam = endpoint.parameters.find(
      (p: { name: string; in: string }) =>
        p.name === 'token' && p.in === 'query'
    )
    expect(tokenParam).toBeDefined()
    expect(tokenParam.required).toBe(true)

    expect(endpoint.responses['200']).toBeDefined()
    expect(endpoint.responses['400']).toBeDefined()
    expect(endpoint.responses['500']).toBeDefined()
  })

  it('defines the email identity and verification response schemas', () => {
    const schemas = spec.components.schemas

    expect(schemas.EmailIdentityStatus).toBeDefined()
    expect(schemas.EmailIdentityStatus.enum).toEqual([
      'PENDING',
      'VERIFIED',
      'BOUNCED',
      'COMPLAINED',
      'SUPPRESSED',
    ])

    expect(schemas.RequestEmailVerificationRequest).toBeDefined()
    expect(schemas.RequestEmailVerificationRequest.required).toContain('email')

    expect(schemas.GenericEmailVerificationResponse).toBeDefined()
    expect(schemas.GenericEmailVerificationResponse.required).toEqual([
      'success',
      'message',
    ])

    expect(schemas.EmailIdentity).toBeDefined()
    expect(schemas.EmailIdentity.required).toEqual(['email', 'status'])

    expect(schemas.PendingEmailIdentity).toBeDefined()
    expect(schemas.VerifiedEmailIdentity).toBeDefined()
    expect(schemas.PendingEmailVerificationResponse).toBeDefined()
    expect(schemas.VerifiedEmailVerificationResponse).toBeDefined()
    expect(schemas.EmailVerificationResponse).toBeDefined()
  })
})
