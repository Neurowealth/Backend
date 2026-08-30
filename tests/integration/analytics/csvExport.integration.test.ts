/**
 * #405 — CSV export for /analytics/user-yield and /analytics/attribution.
 *
 * Mounts the REAL analytics router with only auth and the DB mocked, so the
 * request travels through the real export routes and the real toCsv utility
 * (src/utils/csv.ts) — no second CSV writer, per the issue's ask.
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

const mockDb = db as any

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1/analytics', require('../../../src/routes/analytics').default)
  return app
}

// Minimal CSV parser for RFC-4180-ish output without quoted commas in these
// fixtures — good enough to assert row/column values without depending on a
// third CSV library the app itself doesn't use.
function parseCsv(csv: string): string[][] {
  return csv.split('\r\n').map((line) => line.split(','))
}

describe('GET /api/v1/analytics/user-yield/export', () => {
  const snapshotDate = new Date('2026-08-01T00:00:00.000Z')

  beforeEach(() => {
    mockDb.position = {
      findMany: jest
        .fn()
        .mockResolvedValue([{ yieldEarned: 10, assetSymbol: 'USDC' }]),
    }
    mockDb.yieldSnapshot = {
      findMany: jest
        .fn()
        .mockResolvedValue([
          { snapshotAt: snapshotDate, yieldAmount: 4, apy: 8 },
        ]),
    }
  })

  it('returns CSV with headers matching the JSON shape and CSV content-type', async () => {
    const [jsonRes, csvRes] = await Promise.all([
      request(buildApp()).get('/api/v1/analytics/user-yield?period=30d'),
      request(buildApp()).get(
        '/api/v1/analytics/user-yield/export?period=30d&format=csv'
      ),
    ])

    expect(jsonRes.status).toBe(200)
    expect(csvRes.status).toBe(200)
    expect(csvRes.headers['content-type']).toContain('text/csv')
    expect(csvRes.headers['content-disposition']).toContain(
      'user-yield-30d.csv'
    )

    const rows = parseCsv(csvRes.text)
    expect(rows[0]).toEqual([
      'userId',
      'period',
      'totalYield',
      'periodYield',
      'averageApy',
      'date',
      'yieldAmount',
      'apy',
    ])

    // Exactly one data row for the one snapshot point, values matching JSON.
    expect(rows).toHaveLength(2)
    const [
      userId,
      period,
      totalYield,
      periodYield,
      averageApy,
      date,
      yieldAmount,
      apy,
    ] = rows[1]
    expect(userId).toBe(jsonRes.body.userId)
    expect(period).toBe(jsonRes.body.period)
    expect(Number(totalYield)).toBe(jsonRes.body.totalYield)
    expect(Number(periodYield)).toBe(jsonRes.body.periodYield)
    expect(Number(averageApy)).toBe(jsonRes.body.averageApy)
    expect(date).toBe(jsonRes.body.points[0].date)
    expect(Number(yieldAmount)).toBe(jsonRes.body.points[0].yieldAmount)
    expect(Number(apy)).toBe(jsonRes.body.points[0].apy)
  })

  it('emits a single totals-only row when there are no yield points', async () => {
    mockDb.yieldSnapshot.findMany.mockResolvedValue([])

    const res = await request(buildApp()).get(
      '/api/v1/analytics/user-yield/export?period=30d&format=csv'
    )

    expect(res.status).toBe(200)
    const rows = parseCsv(res.text)
    expect(rows).toHaveLength(2)
    expect(rows[1].slice(5)).toEqual(['', '', ''])
  })

  it('rejects an invalid period the same way as the JSON endpoint', async () => {
    const res = await request(buildApp()).get(
      '/api/v1/analytics/user-yield/export?period=1y'
    )
    expect(res.status).toBe(400)
  })
})

describe('GET /api/v1/analytics/attribution/export', () => {
  const computedAt = new Date('2026-08-01T00:00:00.000Z')

  beforeEach(() => {
    mockDb.portfolioAttribution = {
      findUnique: jest.fn().mockResolvedValue({
        windowDays: 30,
        portfolioReturn: 0.05,
        benchmarkReturn: 0.03,
        allocationEffect: 0.01,
        selectionEffect: 0.01,
        unattributedEffect: 0,
        reconciliationGap: 0,
        reconciled: true,
        benchmarkVersion: 'v1',
        sectorBreakdown: [
          {
            sector: 'Lending',
            portfolioWeight: 0.6,
            benchmarkWeight: 0.5,
            portfolioReturn: 0.04,
            benchmarkReturn: 0.03,
            allocationEffect: 0.005,
            selectionEffect: 0.005,
          },
        ],
        computedAt,
      }),
    }
  })

  it('returns CSV with one row per sector matching the JSON shape', async () => {
    const [jsonRes, csvRes] = await Promise.all([
      request(buildApp()).get('/api/v1/analytics/attribution?window=30d'),
      request(buildApp()).get(
        '/api/v1/analytics/attribution/export?window=30d&format=csv'
      ),
    ])

    expect(jsonRes.status).toBe(200)
    expect(csvRes.status).toBe(200)
    expect(csvRes.headers['content-type']).toContain('text/csv')
    expect(csvRes.headers['content-disposition']).toContain(
      'attribution-30d.csv'
    )

    const rows = parseCsv(csvRes.text)
    expect(rows[0][0]).toBe('userId')
    expect(rows).toHaveLength(2)

    const row = rows[1]
    expect(row[0]).toBe(jsonRes.body.userId)
    expect(row[2]).toBe('true') // computed
    expect(Number(row[3])).toBe(jsonRes.body.portfolioReturn)
    expect(Number(row[5])).toBe(jsonRes.body.vsBenchmark)
    expect(row[13]).toBe(jsonRes.body.sectors[0].sector)
    expect(Number(row[14])).toBe(jsonRes.body.sectors[0].portfolioWeight)
  })

  it('emits a single not-computed row when no attribution exists yet', async () => {
    mockDb.portfolioAttribution.findUnique.mockResolvedValue(null)

    const res = await request(buildApp()).get(
      '/api/v1/analytics/attribution/export?window=30d&format=csv'
    )

    expect(res.status).toBe(200)
    const rows = parseCsv(res.text)
    expect(rows).toHaveLength(2)
    expect(rows[1][1]).toBe('30d')
    expect(rows[1][2]).toBe('false')
  })

  it('rejects an invalid window the same way as the JSON endpoint', async () => {
    const res = await request(buildApp()).get(
      '/api/v1/analytics/attribution/export?window=1d'
    )
    expect(res.status).toBe(400)
  })
})
