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

import request from 'supertest'
import express from 'express'
import healthRouter from '../../../src/routes/health'

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

  it('should return 503 if stellar rpc check fails', async () => {
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

    expect(res.status).toBe(503)
    expect(res.body.status).toBe('unhealthy')
    expect(res.body.checks.stellarRpc.status).toBe('unhealthy')
  })

  it('should return 503 if twilio check fails', async () => {
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

    expect(res.status).toBe(503)
    expect(res.body.status).toBe('unhealthy')
    expect(res.body.checks.twilio.status).toBe('unhealthy')
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

  it('should timeout individual dependency checks after 3s', async () => {
    mockQueryRaw.mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 5000))
    )
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
    expect(res.body.checks.database.status).toBe('unhealthy')
    expect(res.body.checks.database.error).toContain('timed out')
  })
})
