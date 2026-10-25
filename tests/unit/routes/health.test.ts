process.env.NODE_ENV = 'test'
process.env.STELLAR_NETWORK = 'testnet'
process.env.STELLAR_RPC_URL = 'https://soroban-testnet.stellar.org'
process.env.STELLAR_AGENT_SECRET_KEY = 'S' + 'A'.repeat(55)
process.env.VAULT_CONTRACT_ID = 'C' + 'A'.repeat(55)
process.env.USDC_TOKEN_ADDRESS = 'C' + 'B'.repeat(55)
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key'
process.env.DATABASE_URL = 'postgresql://localhost:5432/test'
process.env.JWT_SEED = '0'.repeat(64)
process.env.WALLET_ENCRYPTION_KEY = '0'.repeat(64)
process.env.TWILIO_AUTH_TOKEN = '0'.repeat(32)
process.env.TWILIO_ACCOUNT_SID = 'AC' + '0'.repeat(32)
process.env.INTERNAL_SERVICE_TOKEN = 'test-internal-token'
// Small per-check budget so hung-dependency tests stay fast
process.env.HEALTH_CHECK_TIMEOUT_MS = '300'

import request from 'supertest'
import express from 'express'
import healthRouter from '../../../src/routes/health'
import { register } from '../../../src/utils/metrics'

const app = express()
app.use('/health', healthRouter)

// Mock the dependencies
const mockQueryRaw = jest.fn()
jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: {
    $queryRaw: (...args: any[]) => mockQueryRaw(...args),
  },
}))

const mockStellarExecute = jest.fn()
jest.mock('../../../src/stellar/client', () => ({
  __esModule: true,
  getResilientClient: () => ({
    execute: mockStellarExecute,
  }),
}))

const mockTwilioFetch = jest.fn()
const mockTwilioClient = {
  api: {
    accounts: () => ({
      fetch: mockTwilioFetch,
    }),
  },
}
jest.mock('twilio', () => {
  return jest.fn().mockImplementation(() => mockTwilioClient)
})

const mockGetAgentStatus = jest.fn()
jest.mock('../../../src/agent/loop', () => ({
  __esModule: true,
  getAgentStatus: () => mockGetAgentStatus(),
}))

const healthyAgent = () => ({
  isRunning: true,
  lastTickAt: new Date(),
  lastError: null,
  healthStatus: 'healthy',
})

describe('GET /health/deep', () => {
  const token = 'test-internal-token'

  beforeEach(() => {
    jest.clearAllMocks()
    process.env.INTERNAL_SERVICE_TOKEN = token
    process.env.TWILIO_ACCOUNT_SID = 'AC123'
    process.env.TWILIO_AUTH_TOKEN = 'token123'
  })

  it('should return 401 if unauthorized', async () => {
    const res = await request(app).get('/health/deep')
    expect(res.status).toBe(401)
  })

  it('should return 200 and healthy status when all dependencies are healthy', async () => {
    mockQueryRaw.mockResolvedValue([1])
    mockStellarExecute.mockResolvedValue({ sequence: 12345 })
    mockTwilioFetch.mockResolvedValue({})
    mockGetAgentStatus.mockReturnValue({
      isRunning: true,
      lastTickAt: new Date(),
      lastError: null,
      healthStatus: 'healthy',
    })

    const res = await request(app)
      .get('/health/deep')
      .set('X-Internal-Token', token)

    expect(res.status).toBe(200)
    expect(res.body.status).toBe('healthy')
    expect(res.body.checks.database.status).toBe('healthy')
    expect(res.body.checks.stellarRpc.status).toBe('healthy')
    expect(res.body.checks.stellarRpc.ledger).toBe(12345)
    expect(res.body.checks.twilio.status).toBe('healthy')
    expect(res.body.checks.agentLoop.status).toBe('healthy')
    expect(res.body.degradedDependencies).toEqual([])
  })

  it('should return 503 if database check fails', async () => {
    mockQueryRaw.mockRejectedValue(new Error('DB Connection Failed'))
    mockStellarExecute.mockResolvedValue({ sequence: 12345 })
    mockTwilioFetch.mockResolvedValue({})
    mockGetAgentStatus.mockReturnValue({
      isRunning: true,
      lastTickAt: new Date(),
      lastError: null,
      healthStatus: 'healthy',
    })

    const res = await request(app)
      .get('/health/deep')
      .set('X-Internal-Token', token)

    expect(res.status).toBe(503)
    expect(res.body.status).toBe('unhealthy')
    expect(res.body.checks.database.status).toBe('unhealthy')
    expect(res.body.checks.database.error).toBe('DB Connection Failed')
  })

  it('should return 200 degraded if stellar rpc check fails (non-critical)', async () => {
    mockQueryRaw.mockResolvedValue([1])
    mockStellarExecute.mockRejectedValue(new Error('RPC Error'))
    mockTwilioFetch.mockResolvedValue({})
    mockGetAgentStatus.mockReturnValue({
      isRunning: true,
      lastTickAt: new Date(),
      lastError: null,
      healthStatus: 'healthy',
    })

    const res = await request(app)
      .get('/health/deep')
      .set('X-Internal-Token', token)

    expect(res.status).toBe(200)
    expect(res.body.status).toBe('degraded')
    expect(res.body.checks.stellarRpc.status).toBe('unhealthy')
    expect(res.body.degradedDependencies).toEqual(['stellarRpc'])
  })

  it('should return 200 degraded if twilio check fails (non-critical)', async () => {
    mockQueryRaw.mockResolvedValue([1])
    mockStellarExecute.mockResolvedValue({ sequence: 12345 })
    mockTwilioFetch.mockRejectedValue(new Error('Twilio Auth Error'))
    mockGetAgentStatus.mockReturnValue({
      isRunning: true,
      lastTickAt: new Date(),
      lastError: null,
      healthStatus: 'healthy',
    })

    const res = await request(app)
      .get('/health/deep')
      .set('X-Internal-Token', token)

    expect(res.status).toBe(200)
    expect(res.body.status).toBe('degraded')
    expect(res.body.checks.twilio.status).toBe('unhealthy')
    expect(res.body.degradedDependencies).toEqual(['twilio'])
  })

  it('should return 503 if agent loop has not ticked within 2x interval', async () => {
    mockQueryRaw.mockResolvedValue([1])
    mockStellarExecute.mockResolvedValue({ sequence: 12345 })
    mockTwilioFetch.mockResolvedValue({})
    const oldDate = new Date(Date.now() - 65 * 60 * 1000)
    mockGetAgentStatus.mockReturnValue({
      isRunning: true,
      lastTickAt: oldDate,
      lastError: null,
      healthStatus: 'healthy',
    })

    const res = await request(app)
      .get('/health/deep')
      .set('X-Internal-Token', token)

    expect(res.status).toBe(503)
    expect(res.body.status).toBe('unhealthy')
    expect(res.body.checks.agentLoop.status).toBe('unhealthy')
  })

  it('should return 200 and degraded if agent loop is degraded but no unhealthy dependencies', async () => {
    mockQueryRaw.mockResolvedValue([1])
    mockStellarExecute.mockResolvedValue({ sequence: 12345 })
    mockTwilioFetch.mockResolvedValue({})
    mockGetAgentStatus.mockReturnValue({
      isRunning: true,
      lastTickAt: new Date(),
      lastError: 'Some warning',
      healthStatus: 'degraded',
    })

    const res = await request(app)
      .get('/health/deep')
      .set('X-Internal-Token', token)

    expect(res.status).toBe(200)
    expect(res.body.status).toBe('degraded')
    expect(res.body.checks.agentLoop.status).toBe('degraded')
  })

  it('bounds and redacts error detail in the response', async () => {
    mockQueryRaw.mockRejectedValue(
      new Error(`connect failed password=hunter2 ${'x'.repeat(500)}`)
    )
    mockStellarExecute.mockResolvedValue({ sequence: 12345 })
    mockTwilioFetch.mockResolvedValue({})
    mockGetAgentStatus.mockReturnValue(healthyAgent())

    const res = await request(app)
      .get('/health/deep')
      .set('X-Internal-Token', token)

    expect(res.body.checks.database.error).not.toContain('hunter2')
    expect(res.body.checks.database.error.length).toBeLessThanOrEqual(201)
  })

  it('records a per-dependency status metric', async () => {
    mockQueryRaw.mockResolvedValue([1])
    mockStellarExecute.mockRejectedValue(new Error('RPC Error'))
    mockTwilioFetch.mockResolvedValue({})
    mockGetAgentStatus.mockReturnValue(healthyAgent())

    await request(app).get('/health/deep').set('X-Internal-Token', token)

    const metrics = await register.getSingleMetricAsString(
      'health_dependency_status'
    )
    expect(metrics).toMatch(
      /health_dependency_status\{[^}]*dependency="stellarRpc"[^}]*\} 2/
    )
    expect(metrics).toMatch(
      /health_dependency_status\{[^}]*dependency="database"[^}]*\} 0/
    )
  })

  // Chaos: hang one dependency at a time and assert probe latency stays
  // bounded and the pod-level outcome matches DEPENDENCY_POLICY.
  describe('with a hung dependency', () => {
    const BUDGET_MS = 300
    const hang = () => new Promise(() => {})

    it.each([
      ['database', 503, 'unhealthy'],
      ['stellarRpc', 200, 'degraded'],
      ['twilio', 200, 'degraded'],
    ])(
      'bounds probe latency when %s hangs and returns %i',
      async (dependency, expectedCode, expectedStatus) => {
        mockQueryRaw.mockImplementation(() =>
          dependency === 'database' ? hang() : Promise.resolve([1])
        )
        mockStellarExecute.mockImplementation(() =>
          dependency === 'stellarRpc'
            ? hang()
            : Promise.resolve({ sequence: 12345 })
        )
        mockTwilioFetch.mockImplementation(() =>
          dependency === 'twilio' ? hang() : Promise.resolve({})
        )
        mockGetAgentStatus.mockReturnValue(healthyAgent())

        const started = Date.now()
        const res = await request(app)
          .get('/health/deep')
          .set('X-Internal-Token', token)
        const elapsed = Date.now() - started

        expect(elapsed).toBeLessThan(BUDGET_MS + 700)
        expect(res.status).toBe(expectedCode)
        expect(res.body.status).toBe(expectedStatus)
        expect(res.body.degradedDependencies).toEqual([dependency])
        expect(res.body.checks[dependency].status).toBe('unhealthy')
        expect(res.body.checks[dependency].error).toContain('timed out')
      }
    )

    it('bounds probe latency when every dependency hangs at once', async () => {
      mockQueryRaw.mockImplementation(hang)
      mockStellarExecute.mockImplementation(hang)
      mockTwilioFetch.mockImplementation(hang)
      mockGetAgentStatus.mockReturnValue(healthyAgent())

      const started = Date.now()
      const res = await request(app)
        .get('/health/deep')
        .set('X-Internal-Token', token)

      // Checks run in parallel, so total latency ~= one budget, not the sum
      expect(Date.now() - started).toBeLessThan(BUDGET_MS + 700)
      expect(res.status).toBe(503)
      expect(res.body.degradedDependencies).toEqual(
        expect.arrayContaining(['database', 'stellarRpc', 'twilio'])
      )
    })
  })
})

describe('GET /health/ready', () => {
  it('returns 503 with subsystem state until startup dependencies are ready', async () => {
    const res = await request(app).get('/health/ready')

    expect(res.status).toBe(503)
    expect(res.body.ready).toBe(false)
    expect(res.body.subsystems).toEqual(
      expect.objectContaining({
        database: expect.any(Boolean),
        stellarNetwork: expect.any(Boolean),
        eventListener: expect.any(Boolean),
        agentLoop: expect.any(Boolean),
      })
    )
  })
})
