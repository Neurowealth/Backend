import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it, jest } from '@jest/globals'
import {
  requestTimeoutMiddleware,
  resolveRequestTimeout,
} from '../../../src/middleware/requestTimeout'
import { register } from '../../../src/utils/metrics'
import { config } from '../../../src/config/env'

describe('requestTimeout middleware', () => {
  afterEach(() => {
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
    // Fake timers can't drive a real supertest socket round-trip — shrink the
    // configured window instead and let the timeout fire for real.
    jest.replaceProperty(config, 'requestTimeoutMs', 100)

    const app = express()
    app.use(requestTimeoutMiddleware)
    app.get('/slow', async () => {
      await new Promise(() => {
        // Intentionally never resolves so the timeout middleware fires.
      })
    })

    const res = await request(app).get('/slow')

    expect(res.status).toBe(504)
    expect(res.body).toEqual({ error: 'Request timed out' })

    const metrics = await register.metrics()
    // The registry appends default labels (e.g. env), so match loosely.
    expect(metrics).toMatch(
      /request_timeouts_total\{[^}]*route_group="general"[^}]*\} 1/
    )
  })
})
