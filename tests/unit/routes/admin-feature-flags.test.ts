process.env.NODE_ENV = 'test'
process.env.JWT_SEED = '0'.repeat(64)
process.env.DATABASE_URL = 'postgresql://localhost:5432/test'

// Mock db/prisma before importing admin router
jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: {
    adminAuditLog: {
      create: jest.fn().mockResolvedValue({ id: 'mock-audit-id' }),
    },
    adminApiKey: {
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
    },
    auditBlock: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  },
}))

// Mock admin auth middleware to enable testing RBAC scopes easily
jest.mock('../../../src/middleware/adminAuth', () => {
  const actual = jest.requireActual('../../../src/middleware/adminAuth')
  return {
    ...actual,
    requireAdminAuth: (req: any, res: any, next: any) => {
      const scopesHeader = req.headers['x-mock-scopes']
      const scopes = scopesHeader ? (scopesHeader as string).split(',').map((s: string) => s.trim()) : ['super']
      res.locals.adminAuth = {
        id: 'admin-key-1',
        name: 'Test SRE Operator',
        role: 'operator',
        scopes,
      }
      next()
    },
  }
})

import express from 'express'
import request from 'supertest'
import adminRouter from '../../../src/routes/admin'
import { featureFlagManager } from '../../../src/config/featureFlags'

const app = express()
app.use(express.json())
app.use('/api/v1/admin', adminRouter)

describe('Admin Feature Flag Endpoints (#494)', () => {
  beforeEach(() => {
    featureFlagManager.resetAll()
  })

  afterEach(() => {
    featureFlagManager.resetAll()
  })

  describe('GET /api/v1/admin/feature-flags', () => {
    it('returns all feature flags and runtime environment', async () => {
      const res = await request(app).get('/api/v1/admin/feature-flags')

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data.environment).toBe('test')
      expect(Array.isArray(res.body.data.flags)).toBe(true)
      expect(res.body.data.flags.length).toBeGreaterThan(0)

      const dcaFlag = res.body.data.flags.find((f: any) => f.key === 'smart_dca_engine')
      expect(dcaFlag).toBeDefined()
      expect(dcaFlag.currentEvaluation).toBeDefined()
    })

    it('evaluates flags with entityId query parameter', async () => {
      const res = await request(app)
        .get('/api/v1/admin/feature-flags')
        .query({ entityId: 'user_target_abc' })

      expect(res.status).toBe(200)
      const dcaFlag = res.body.data.flags.find((f: any) => f.key === 'smart_dca_engine')
      expect(dcaFlag.currentEvaluation.entityId).toBe('user_target_abc')
    })
  })

  describe('GET /api/v1/admin/feature-flags/:key', () => {
    it('returns flag details when flag exists', async () => {
      const res = await request(app).get('/api/v1/admin/feature-flags/smart_dca_engine')

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data.key).toBe('smart_dca_engine')
      expect(res.body.data.currentEvaluation).toBeDefined()
    })

    it('returns 404 when flag does not exist', async () => {
      const res = await request(app).get('/api/v1/admin/feature-flags/non_existent_key')

      expect(res.status).toBe(404)
      expect(res.body.success).toBe(false)
      expect(res.body.error).toContain('not found')
    })
  })

  describe('PUT /api/v1/admin/feature-flags/:key', () => {
    it('updates runtime overrides and returns new evaluation', async () => {
      const res = await request(app)
        .put('/api/v1/admin/feature-flags/circuit_breaker_v2')
        .send({
          enabled: false,
          rolloutPercentage: 0,
        })

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data.enabled).toBe(false)
      expect(res.body.data.decision).toBe('RUNTIME_OVERRIDE')
    })

    it('rejects invalid rolloutPercentage (>100 or <0)', async () => {
      const res = await request(app)
        .put('/api/v1/admin/feature-flags/circuit_breaker_v2')
        .send({ rolloutPercentage: 150 })

      expect(res.status).toBe(400)
      expect(res.body.success).toBe(false)
      expect(res.body.error).toContain('rolloutPercentage must be a number between 0 and 100')
    })

    it('rejects non-array allowlist', async () => {
      const res = await request(app)
        .put('/api/v1/admin/feature-flags/circuit_breaker_v2')
        .send({ allowlist: 'not-an-array' })

      expect(res.status).toBe(400)
      expect(res.body.error).toContain('allowlist must be an array')
    })

    it('returns 404 for unknown flag', async () => {
      const res = await request(app)
        .put('/api/v1/admin/feature-flags/fake_flag')
        .send({ enabled: true })

      expect(res.status).toBe(404)
    })
  })

  describe('POST /api/v1/admin/feature-flags/:key/staged-rollout', () => {
    it('advances staged rollout percentage', async () => {
      const res = await request(app)
        .post('/api/v1/admin/feature-flags/smart_dca_engine/staged-rollout')
        .send({ percentage: 25 })

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data.rolloutPercentage).toBe(25)
    })

    it('validates percentage is between 0 and 100', async () => {
      const res1 = await request(app)
        .post('/api/v1/admin/feature-flags/smart_dca_engine/staged-rollout')
        .send({ percentage: -5 })
      expect(res1.status).toBe(400)

      const res2 = await request(app)
        .post('/api/v1/admin/feature-flags/smart_dca_engine/staged-rollout')
        .send({ percentage: 'full' })
      expect(res2.status).toBe(400)
    })
  })

  describe('POST /api/v1/admin/feature-flags/:key/rollback', () => {
    it('executes fast emergency rollback, sets rolledBack=true, drops percentage to 0', async () => {
      // First rollout
      featureFlagManager.stagedRollout('enhanced_stellar_routing', 50)

      // Trigger rollback
      const res = await request(app)
        .post('/api/v1/admin/feature-flags/enhanced_stellar_routing/rollback')
        .send({ reason: 'Slippage anomalies observed in multi-hop paths' })

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data.flagKey).toBe('enhanced_stellar_routing')
      expect(res.body.data.reason).toBe('Slippage anomalies observed in multi-hop paths')
      expect(res.body.data.operator).toBe('Test SRE Operator (operator)')

      // Verify flag is now disabled
      const evalRes = featureFlagManager.evaluate('enhanced_stellar_routing')
      expect(evalRes.enabled).toBe(false)
      expect(evalRes.decision).toBe('EMERGENCY_ROLLBACK')
      expect(evalRes.rolloutPercentage).toBe(0)
    })

    it('requires a reason for rollback', async () => {
      const res = await request(app)
        .post('/api/v1/admin/feature-flags/enhanced_stellar_routing/rollback')
        .send({})

      expect(res.status).toBe(400)
      expect(res.body.success).toBe(false)
      expect(res.body.error).toBe('reason is required')
    })
  })

  describe('GET /api/v1/admin/feature-flags/history', () => {
    it('returns history of emergency rollbacks', async () => {
      // Trigger a rollback
      await request(app)
        .post('/api/v1/admin/feature-flags/fast_fiat_onramp/rollback')
        .send({ reason: 'Provider latency spike' })

      const res = await request(app).get('/api/v1/admin/feature-flags/history')

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(Array.isArray(res.body.data)).toBe(true)
      expect(res.body.data.length).toBeGreaterThan(0)
      expect(res.body.data[0].flagKey).toBe('fast_fiat_onramp')
      expect(res.body.data[0].reason).toBe('Provider latency spike')
    })
  })

  describe('POST /api/v1/admin/feature-flags/:key/reset', () => {
    it('resets flag back to default configuration', async () => {
      // Modify override
      featureFlagManager.setOverride('smart_dca_engine', { enabled: false })
      expect(featureFlagManager.evaluate('smart_dca_engine').enabled).toBe(false)

      const res = await request(app).post('/api/v1/admin/feature-flags/smart_dca_engine/reset')

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      // In test env, smart_dca_engine default is true
      expect(res.body.data.enabled).toBe(true)
    })
  })

  describe('POST /api/v1/admin/feature-flags/emergency-disable-all', () => {
    it('activates platform emergency kill switch', async () => {
      const res = await request(app)
        .post('/api/v1/admin/feature-flags/emergency-disable-all')
        .send({ reason: 'Critical 0-day upstream exploit detected' })

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)

      // All other flags should now evaluate to false with GLOBAL_MAINTENANCE
      expect(featureFlagManager.evaluate('smart_dca_engine').decision).toBe('GLOBAL_MAINTENANCE')
      expect(featureFlagManager.evaluate('agent_autonomous_rebalance').decision).toBe('GLOBAL_MAINTENANCE')
    })

    it('requires a reason', async () => {
      const res = await request(app)
        .post('/api/v1/admin/feature-flags/emergency-disable-all')
        .send({})

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('reason is required')
    })
  })

  describe('RBAC Scopes Enforcement', () => {
    it('allows read-scoped key to GET flags', async () => {
      const res = await request(app)
        .get('/api/v1/admin/feature-flags')
        .set('x-mock-scopes', 'flags:read')

      expect(res.status).toBe(200)
    })

    it('denies read-scoped key from mutating flag state (returns 403)', async () => {
      const res = await request(app)
        .post('/api/v1/admin/feature-flags/smart_dca_engine/rollback')
        .set('x-mock-scopes', 'flags:read')
        .send({ reason: 'Unauthorized rollback attempt' })

      expect(res.status).toBe(403)
      expect(res.body.success).toBe(false)
      expect(res.body.error).toContain("Admin scope 'flags:write' required")
    })

    it('allows write-scoped key to execute rollback', async () => {
      const res = await request(app)
        .post('/api/v1/admin/feature-flags/smart_dca_engine/rollback')
        .set('x-mock-scopes', 'flags:write')
        .send({ reason: 'Authorized operator rollback' })

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
    })
  })
})
