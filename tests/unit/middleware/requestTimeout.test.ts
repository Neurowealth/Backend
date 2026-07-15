import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals'
import { requestTimeoutMiddleware, resolveRequestTimeout } from '../../../src/middleware/requestTimeout'
import { register } from '../../../src/utils/metrics'

describe('requestTimeout middleware', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    register.resetMetrics()
  })

  afterEach(() => {
    jest.useRealTimers()
    register.resetMetrics()
    jest.restoreAllMocks()
  })

  it('applies route-specific timeout windows', () => {
    expect(resolveRequestTimeout('/health/live')).toEqual({
      timeoutMs: 5_000,
      routeGroup: 'health',
    })
    expect(resolveRequestTimeout('/metrics')).toEqual({
      timeoutMs: 5_000,
      routeGroup: 'health',
    })
    expect(resolveRequestTimeout('/api/v1/agent/status')).toEqual({
      timeoutMs: 60_000,
      routeGroup: 'agent',
    })
    expect(resolveRequestTimeout('/api/withdraw')).toEqual({
      timeoutMs: 30_000,
      routeGroup: 'general',
    })
  })

  it('returns 504 when a route exceeds the configured timeout', async () => {
    const app = express()
    app.use(requestTimeoutMiddleware)
    app.get('/slow', async () => {
      await new Promise(() => {
        // Intentionally never resolves so the timeout middleware fires.
      })
    })

    const pending = request(app).get('/slow')
    jest.advanceTimersByTime(30_000)
    await Promise.resolve()
    const res = await pending

    expect(res.status).toBe(504)
    expect(res.body).toEqual({ error: 'Request timed out' })

    const metrics = await register.metrics()
    expect(metrics).toContain('request_timeouts_total{route_group="general"} 1')
  })
})
