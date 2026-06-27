/**
 * Integration tests for the API versioning strategy (Issue #256).
 *
 * Verifies:
 *  - All responses carry the X-API-Version header
 *  - Routes are reachable under the versioned /api/v1 prefix
 *  - Legacy unversioned /api routes still function but emit deprecation headers
 *  - The versioned routes are NOT marked deprecated
 */

import request from 'supertest'
import app from '../../src/index'

describe('API versioning', () => {
  it('sets X-API-Version on every response', async () => {
    const res = await request(app).get('/health/live')
    expect(res.headers['x-api-version']).toBe('1')
  })

  it('serves resources under the versioned /api/v1 prefix', async () => {
    // Missing body → 400 from the validation layer proves the route is mounted.
    const res = await request(app).post('/api/v1/auth/challenge').send({})
    expect(res.status).toBe(400)
    expect(res.headers['x-api-version']).toBe('1')
    expect(res.headers['deprecation']).toBeUndefined()
  })

  it('keeps the legacy unversioned route working but marks it deprecated', async () => {
    const res = await request(app).post('/api/auth/challenge').send({})
    expect(res.status).toBe(400)
    expect(res.headers['deprecation']).toBe('true')
    expect(res.headers['sunset']).toBeDefined()
    expect(res.headers['link']).toContain('rel="successor-version"')
    expect(res.headers['link']).toContain('/api/v1/auth')
  })
})
