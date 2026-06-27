import express from 'express'
import request from 'supertest'
import { securityHeaders, permissionsPolicy } from '../../src/middleware/security'

jest.mock('../../src/config/env', () => ({
  config: {
    nodeEnv: 'production',
    security: { trustProxy: 1 },
  },
}))

function buildApp() {
  const app = express()
  app.disable('x-powered-by')
  app.use(securityHeaders())
  app.use(permissionsPolicy())
  app.get('/ping', (_req, res) => res.status(200).json({ ok: true }))
  return app
}

describe('security headers — production', () => {
  let app: ReturnType<typeof buildApp>

  beforeAll(() => {
    app = buildApp()
  })

  it('sets Content-Security-Policy with all required directives', async () => {
    const res = await request(app).get('/ping')
    const csp = res.headers['content-security-policy'] as string

    expect(csp).toBeDefined()
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("script-src 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("form-action 'none'")
    expect(csp).toContain('upgrade-insecure-requests')
  })

  it('sets Strict-Transport-Security with 2-year max-age and preload', async () => {
    const res = await request(app).get('/ping')
    const hsts = res.headers['strict-transport-security'] as string

    expect(hsts).toBeDefined()
    expect(hsts).toContain('max-age=63072000')
    expect(hsts).toContain('includeSubDomains')
    expect(hsts).toContain('preload')
  })

  it('sets Referrer-Policy to no-referrer', async () => {
    const res = await request(app).get('/ping')
    expect(res.headers['referrer-policy']).toBe('no-referrer')
  })

  it('sets X-Content-Type-Options to nosniff', async () => {
    const res = await request(app).get('/ping')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
  })

  it('sets X-Frame-Options to DENY', async () => {
    const res = await request(app).get('/ping')
    expect(res.headers['x-frame-options']).toBe('DENY')
  })

  it('sets Cross-Origin-Opener-Policy to same-origin', async () => {
    const res = await request(app).get('/ping')
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin')
  })

  it('sets Cross-Origin-Resource-Policy to same-origin', async () => {
    const res = await request(app).get('/ping')
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin')
  })

  it('sets Permissions-Policy disabling geolocation, camera, and microphone', async () => {
    const res = await request(app).get('/ping')
    const pp = res.headers['permissions-policy'] as string

    expect(pp).toBeDefined()
    expect(pp).toContain('geolocation=()')
    expect(pp).toContain('camera=()')
    expect(pp).toContain('microphone=()')
    expect(pp).toContain('payment=()')
  })

  it('does not expose X-Powered-By', async () => {
    const res = await request(app).get('/ping')
    expect(res.headers['x-powered-by']).toBeUndefined()
  })
})

describe('security headers — non-production (CSP and HSTS disabled)', () => {
  let app: ReturnType<typeof express>

  beforeAll(() => {
    jest.resetModules()
    jest.doMock('../../src/config/env', () => ({
      config: { nodeEnv: 'test', security: { trustProxy: 1 } },
    }))
    const { securityHeaders: sh, permissionsPolicy: pp } =
      jest.requireActual('../../src/middleware/security') as typeof import('../../src/middleware/security')
    app = express()
    app.use(sh())
    app.use(pp())
    app.get('/ping', (_req, res) => res.status(200).json({ ok: true }))
  })

  it('does not set CSP in non-production', async () => {
    const res = await request(app).get('/ping')
    expect(res.headers['content-security-policy']).toBeUndefined()
  })

  it('does not set HSTS in non-production', async () => {
    const res = await request(app).get('/ping')
    expect(res.headers['strict-transport-security']).toBeUndefined()
  })

  it('still sets Permissions-Policy in non-production', async () => {
    const res = await request(app).get('/ping')
    expect(res.headers['permissions-policy']).toBeDefined()
  })
})
