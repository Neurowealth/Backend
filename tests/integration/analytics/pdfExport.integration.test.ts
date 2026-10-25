/**
 * #670 — PDF download route: auth, no-store cache headers, input caps and
 * concurrency rejection are exercised through the real analytics router.
 */
const ownerUserId = '11111111-1111-4111-8111-111111111111'

import request from 'supertest'
import express from 'express'

jest.mock('../../../src/middleware/authenticate', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.userId = ownerUserId
    req.auth = { userId: ownerUserId, walletAddress: 'GWALLET_OWNER' }
    next()
  },
}))

jest.mock('../../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  logBackgroundJob: jest.fn(),
  requestLogger: (_req: any, _res: any, next: any) => next(),
}))

jest.mock('../../../src/db', () => ({ __esModule: true, default: {} }))

import db from '../../../src/db'
import { PDF_LIMITS, withPdfSlot } from '../../../src/utils/pdf'

const mockDb = db as any

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1/analytics', require('../../../src/routes/analytics').default)
  return app
}

beforeEach(() => {
  mockDb.position = {
    findMany: jest
      .fn()
      .mockResolvedValue([{ yieldEarned: 10, assetSymbol: 'USDC' }]),
  }
  mockDb.yieldSnapshot = {
    findMany: jest.fn().mockResolvedValue([
      {
        snapshotAt: new Date('2026-08-01T00:00:00.000Z'),
        yieldAmount: 4,
        apy: 8,
      },
    ]),
  }
})

describe('GET /api/v1/analytics/user-yield/export?format=pdf (#670)', () => {
  it('returns a PDF with private, no-store cache headers', async () => {
    const res = await request(buildApp()).get(
      '/api/v1/analytics/user-yield/export?period=30d&format=pdf'
    )

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('application/pdf')
    expect(res.headers['cache-control']).toBe('private, no-store, max-age=0')
    expect(res.headers['pragma']).toBe('no-cache')
    expect(res.headers['expires']).toBe('0')
    expect(res.headers['content-disposition']).toContain('user-yield-30d.pdf')
  })

  it('rejects an oversized document with 422 before rendering', async () => {
    mockDb.yieldSnapshot.findMany.mockResolvedValue(
      Array.from({ length: PDF_LIMITS.maxLines + 1 }, (_, i) => ({
        snapshotAt: new Date(2026, 0, 1 + (i % 28)),
        yieldAmount: 1,
        apy: 5,
      }))
    )

    const res = await request(buildApp()).get(
      '/api/v1/analytics/user-yield/export?period=30d&format=pdf'
    )

    expect(res.status).toBe(422)
    expect(res.body.code).toBe('PDF_INPUT_TOO_LARGE')
  })

  it('returns 429 with Retry-After while all generation slots are busy', async () => {
    const releases: Array<() => void> = []
    const held = Array.from({ length: PDF_LIMITS.maxConcurrent }, () =>
      withPdfSlot(() => new Promise<void>((resolve) => releases.push(resolve)))
    )

    const res = await request(buildApp()).get(
      '/api/v1/analytics/user-yield/export?period=30d&format=pdf'
    )

    expect(res.status).toBe(429)
    expect(res.body.code).toBe('PDF_GENERATION_BUSY')
    expect(res.headers['retry-after']).toBe(
      String(PDF_LIMITS.retryAfterSeconds)
    )

    releases.forEach((release) => release())
    await Promise.all(held)
  })
})
