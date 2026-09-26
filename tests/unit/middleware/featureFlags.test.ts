import express, { Request, Response } from 'express'
import request from 'supertest'
import {
  requireFeatureFlag,
  featureFlagMiddleware,
  emergencyMaintenanceGuard,
} from '../../../src/middleware/featureFlags'
import { featureFlagManager } from '../../../src/config/featureFlags'

describe('Feature Flag Middleware (#494)', () => {
  beforeEach(() => {
    featureFlagManager.resetAll()
  })

  afterEach(() => {
    featureFlagManager.resetAll()
  })

  describe('requireFeatureFlag guard', () => {
    it('allows the request when the feature flag is enabled', async () => {
      featureFlagManager.setOverride('fast_fiat_onramp', { enabled: true })

      const app = express()
      app.get(
        '/api/v1/fiat/fast-quote',
        requireFeatureFlag('fast_fiat_onramp'),
        (_req: Request, res: Response) => {
          res.json({ success: true, message: 'Fast quote generated' })
        }
      )

      const response = await request(app).get('/api/v1/fiat/fast-quote')
      expect(response.status).toBe(200)
      expect(response.body.success).toBe(true)
    })

    it('rejects the request with 503 FEATURE_DISABLED when the flag is disabled', async () => {
      featureFlagManager.setOverride('fast_fiat_onramp', { enabled: false })

      const app = express()
      app.get(
        '/api/v1/fiat/fast-quote',
        requireFeatureFlag('fast_fiat_onramp', {
          customMessage: 'Instant on-ramp is temporarily disabled',
        }),
        (_req: Request, res: Response) => {
          res.json({ success: true })
        }
      )

      const response = await request(app).get('/api/v1/fiat/fast-quote')
      expect(response.status).toBe(503)
      expect(response.body).toEqual(
        expect.objectContaining({
          success: false,
          code: 'FEATURE_DISABLED',
          flag: 'fast_fiat_onramp',
          error: 'Instant on-ramp is temporarily disabled',
        })
      )
    })

    it('evaluates staged rollout per user ID using custom entityExtractor', async () => {
      // 50% staged rollout
      featureFlagManager.stagedRollout('ai_assistant_tool_calling', 50)

      const app = express()
      app.get(
        '/api/v1/assistant/tools',
        (req: Request, _res: Response, next) => {
          // Mock auth user
          const userId = req.headers['x-user-id'] as string
          if (userId) {
            ;(req as any).user = { id: userId }
          }
          next()
        },
        requireFeatureFlag('ai_assistant_tool_calling', {
          entityExtractor: (req) => (req as any).user?.id || 'anon',
        }),
        (_req: Request, res: Response) => {
          res.json({ success: true, tools: ['rebalance', 'swap'] })
        }
      )

      // An allowlisted user
      featureFlagManager.setOverride('ai_assistant_tool_calling', {
        allowlist: ['allowed_vip_user'],
      })

      const resAllowed = await request(app)
        .get('/api/v1/assistant/tools')
        .set('x-user-id', 'allowed_vip_user')

      expect(resAllowed.status).toBe(200)
      expect(resAllowed.body.success).toBe(true)
    })
  })

  describe('featureFlagMiddleware context injection', () => {
    it('decorates Request with isFeatureEnabled and evaluateFeatureFlag helpers', async () => {
      featureFlagManager.setOverride('circuit_breaker_v2', { enabled: true })

      const app = express()
      app.use(featureFlagMiddleware)
      app.get('/test-context', (req: Request, res: Response) => {
        const isEnabled = req.isFeatureEnabled?.('circuit_breaker_v2')
        const evaluation = req.evaluateFeatureFlag?.('circuit_breaker_v2')
        res.json({ isEnabled, decision: evaluation?.decision })
      })

      const response = await request(app).get('/test-context')
      expect(response.status).toBe(200)
      expect(response.body.isEnabled).toBe(true)
      expect(response.body.decision).toBe('RUNTIME_OVERRIDE')
    })
  })

  describe('emergencyMaintenanceGuard', () => {
    it('allows read-only GET requests even during emergency maintenance', async () => {
      featureFlagManager.setOverride('emergency_maintenance_mode', { enabled: true })

      const app = express()
      app.use(emergencyMaintenanceGuard)
      app.get('/api/v1/portfolio', (_req: Request, res: Response) => {
        res.json({ success: true, balance: 100 })
      })

      const response = await request(app).get('/api/v1/portfolio')
      expect(response.status).toBe(200)
      expect(response.body.balance).toBe(100)
    })

    it('blocks mutating POST requests with 503 during emergency maintenance', async () => {
      featureFlagManager.setOverride('emergency_maintenance_mode', { enabled: true })

      const app = express()
      app.use(emergencyMaintenanceGuard)
      app.post('/api/v1/orders', (_req: Request, res: Response) => {
        res.json({ success: true })
      })

      const response = await request(app).post('/api/v1/orders')
      expect(response.status).toBe(503)
      expect(response.body).toEqual(
        expect.objectContaining({
          success: false,
          code: 'EMERGENCY_MAINTENANCE_ACTIVE',
        })
      )
    })

    it('bypasses emergency maintenance for admin and health routes', async () => {
      featureFlagManager.setOverride('emergency_maintenance_mode', { enabled: true })

      const app = express()
      app.use(emergencyMaintenanceGuard)
      app.post('/api/v1/admin/feature-flags/reset', (_req: Request, res: Response) => {
        res.json({ success: true, message: 'admin reset' })
      })

      const response = await request(app).post('/api/v1/admin/feature-flags/reset')
      expect(response.status).toBe(200)
      expect(response.body.message).toBe('admin reset')
    })
  })
})
