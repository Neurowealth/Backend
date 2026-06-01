/**
 * Integration tests — /health/ready endpoint
 * 
 * Validates readiness probe behavior for load balancers and orchestrators.
 */

import request from 'supertest'
import express, { Express } from 'express'
import healthRouter from '../../../src/routes/health'
import { markReady, markNotReady, getReadiness } from '../../../src/config/readiness'

describe('GET /health/ready', () => {
  let app: Express

  beforeEach(() => {
    app = express()
    app.use('/health', healthRouter)
    
    // Reset all subsystems to not ready before each test
    markNotReady('database')
    markNotReady('eventListener')
    markNotReady('agentLoop')
  })

  it('returns 503 when no subsystems are ready', async () => {
    const response = await request(app).get('/health/ready')

    expect(response.status).toBe(503)
    expect(response.body).toMatchObject({
      ready: false,
      subsystems: {
        database: false,
        eventListener: false,
        agentLoop: false,
      },
    })
    expect(response.body.timestamp).toBeDefined()
  })

  it('returns 503 when only database is ready', async () => {
    markReady('database')

    const response = await request(app).get('/health/ready')

    expect(response.status).toBe(503)
    expect(response.body).toMatchObject({
      ready: false,
      subsystems: {
        database: true,
        eventListener: false,
        agentLoop: false,
      },
    })
  })

  it('returns 503 when only eventListener is ready', async () => {
    markReady('eventListener')

    const response = await request(app).get('/health/ready')

    expect(response.status).toBe(503)
    expect(response.body).toMatchObject({
      ready: false,
      subsystems: {
        database: false,
        eventListener: true,
        agentLoop: false,
      },
    })
  })

  it('returns 503 when only agentLoop is ready', async () => {
    markReady('agentLoop')

    const response = await request(app).get('/health/ready')

    expect(response.status).toBe(503)
    expect(response.body).toMatchObject({
      ready: false,
      subsystems: {
        database: false,
        eventListener: false,
        agentLoop: true,
      },
    })
  })

  it('returns 503 when two subsystems are ready but one is not', async () => {
    markReady('database')
    markReady('eventListener')
    // agentLoop still not ready

    const response = await request(app).get('/health/ready')

    expect(response.status).toBe(503)
    expect(response.body).toMatchObject({
      ready: false,
      subsystems: {
        database: true,
        eventListener: true,
        agentLoop: false,
      },
    })
  })

  it('returns 200 when all subsystems are ready', async () => {
    markReady('database')
    markReady('eventListener')
    markReady('agentLoop')

    const response = await request(app).get('/health/ready')

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      ready: true,
      subsystems: {
        database: true,
        eventListener: true,
        agentLoop: true,
      },
    })
    expect(response.body.timestamp).toBeDefined()
  })

  it('returns 503 after a subsystem becomes not ready', async () => {
    // Start with all ready
    markReady('database')
    markReady('eventListener')
    markReady('agentLoop')

    let response = await request(app).get('/health/ready')
    expect(response.status).toBe(200)

    // Mark one subsystem as not ready
    markNotReady('database')

    response = await request(app).get('/health/ready')
    expect(response.status).toBe(503)
    expect(response.body).toMatchObject({
      ready: false,
      subsystems: {
        database: false,
        eventListener: true,
        agentLoop: true,
      },
    })
  })

  it('includes ISO timestamp in response', async () => {
    const response = await request(app).get('/health/ready')

    expect(response.body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })
})

describe('GET /health', () => {
  let app: Express

  beforeEach(() => {
    app = express()
    app.use('/health', healthRouter)
  })

  it('returns 200 with basic health info', async () => {
    const response = await request(app).get('/health')

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      status: 'ok',
      version: '1.0.0',
    })
    expect(response.body.timestamp).toBeDefined()
    expect(response.body.environment).toBeDefined()
  })
})
